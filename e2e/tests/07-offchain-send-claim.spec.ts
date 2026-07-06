import { type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/test-base.ts";
import {
  readState,
  STATE_FILES,
  type GlobalState,
  type SwapDeploymentState,
} from "../fixtures/state.ts";

/**
 * Spec 07 — offchain delivery: a simple send → receive between two embedded wallets.
 *
 *   1. Recipient onboards an embedded wallet (0 balance) and exposes its L2
 *      address via wallet-chip[data-address].
 *   2. Sender onboards, drips GoCoin, and sends N to the recipient via the Send
 *      tab, producing a shareable claim link.
 *   3. Recipient opens the link and claims — its balance goes 0 → N, verified,
 *      and the sender's balance dropped by at least N (conservation: moved, not minted).
 *
 * Claiming is a local `offchain_receive` simulate (no on-chain tx, no fee), so the
 * recipient wallet needs no funding. Assumes specs 01-04 ran (deployed tokens + FPC
 * signed up for transfer_in_private_with_offchain_delivery).
 *
 * This flow is HEAVY: each embedded wallet runs a full client-side prover, and the
 * send alone is a multi-proof tx. The helpers below are careful about *when* they
 * touch the PXE — see the "warm vs cold PXE" notes on the reload and the balance reads.
 */

const SEND_AMOUNT = "5";

/** Tee a manually-created page's console to stdout (test-base only wires the default `page`). */
function attachConsole(page: Page, tag: string) {
  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning" || t === "info") {
      console.log(`[browser:${tag}:${t}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => console.log(`[browser:${tag}:pageerror] ${err.message}`));
}

/**
 * Fresh isolated context (own OPFS/IndexedDB → own embedded wallet), pinned to local network.
 * `baseURL` is threaded from the test's `baseURL` fixture (the project's `use.baseURL`) because a
 * manually-created `browser.newContext()` does NOT inherit it the way the default `page` fixture does.
 */
async function newAppContext(
  browser: Browser,
  tag: string,
  baseURL: string | undefined,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  attachConsole(page, tag);
  await page.addInitScript(() => {
    try {
      localStorage.setItem("goswap_network", "local");
    } catch {
      /* ignore */
    }
  });
  return { ctx, page };
}

/** Onboard an embedded wallet up to the awaiting_drip step (keys created + persisted). */
async function onboardEmbedded(page: Page): Promise<void> {
  await page.goto("/");
  const chip = page.getByTestId("wallet-chip");
  await chip.waitFor({ timeout: 60_000 });
  await expect(chip).toHaveAttribute("data-connected", "false", { timeout: 30_000 });
  await chip.click();

  const modal = page.getByTestId("onboarding-modal");
  await modal.waitFor({ timeout: 30_000 });
  await page.getByTestId("onboarding-use-embedded").click();

  // awaiting_drip means the embedded account exists (currentAddress is set) and
  // the balance query resolved to 0 — the wallet is ready.
  await expect(modal).toHaveAttribute("data-status", "awaiting_drip", { timeout: 120_000 });
}

/**
 * Close the onboarding modal without dripping (marks onboarding complete, keeps the wallet).
 * The recipient never drips; dismissing the modal here means its backdrop won't occlude the
 * Claim button when the recipient later navigates to the claim route in the same (warm) session.
 */
async function closeOnboardingModal(page: Page): Promise<void> {
  const modal = page.getByTestId("onboarding-modal");
  await modal.getByRole("button", { name: "close" }).click(); // IconButton aria-label="close"
  await modal.waitFor({ state: "hidden", timeout: 10_000 });
}

/** Read the connected wallet's full L2 address from the chip. */
async function readAddress(page: Page): Promise<string> {
  const chip = page.getByTestId("wallet-chip");
  await expect(async () => {
    const addr = await chip.getAttribute("data-address");
    expect(addr).toMatch(/^0x[0-9a-fA-F]+$/);
  }).toPass({ timeout: 30_000 });
  return (await chip.getAttribute("data-address")) as string;
}

/** From awaiting_drip: submit the drip password and wait for the modal to close (drip succeeded). */
async function dripInModal(page: Page, password: string): Promise<void> {
  const modal = page.getByTestId("onboarding-modal");
  const input = page.getByTestId("drip-password-input");
  await input.waitFor({ timeout: 10_000 });
  await input.fill(password);
  await page.getByTestId("drip-password-submit").click();
  // Modal auto-closes on drip success (same terminal signal spec 05 relies on).
  await modal.waitFor({ state: "hidden", timeout: 300_000 });
}

/**
 * Switch to the Swap tab and return swap-from's locator. Uses an in-app tab click, NOT a
 * page reload. Requires the tabbed app to be showing (not the onboarding modal or #/claim route).
 */
async function gotoSwapTab(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: "Swap" }).click();
  const fromBox = page.getByTestId("swap-from");
  await fromBox.waitFor({ timeout: 30_000 });
  return fromBox;
}

/**
 * Post-reload readiness gate + pre-send balance. swap-from's data-balance only resolves once the
 * reloaded PXE has re-synced AND re-registered the token contracts (fetchBalances needs them), so a
 * resolved balance guarantees the subsequent send won't hit "Contracts not initialized". Generous
 * timeout because this straddles a cold PXE re-sync (unlike the warm post-send read below).
 */
async function readGoCoinBalanceAfterReload(page: Page): Promise<bigint> {
  const fromBox = await gotoSwapTab(page);
  let raw = "";
  await expect(async () => {
    raw = (await fromBox.getAttribute("data-balance")) ?? "";
    expect(raw).not.toBe(""); // "" = still loading (cold sync / contracts registering)
  }).toPass({ timeout: 240_000 });
  return BigInt(raw);
}

/** Assert the Swap-tab GoCoin balance settles to `expected` (warm PXE — resolves quickly). */
async function assertGoCoinBalance(page: Page, expected: string): Promise<void> {
  const fromBox = await gotoSwapTab(page);
  await expect(async () => {
    expect(await fromBox.getAttribute("data-balance")).toBe(expected); // "" = loading; retries
  }).toPass({ timeout: 60_000 });
}

/** On the Send tab: send `amount` GoCoin to `recipient`, return the generated claim link. */
async function sendOffchain(page: Page, recipient: string, amount: string): Promise<string> {
  await page.getByRole("tab", { name: "Send" }).click();
  await page.getByTestId("send-recipient-input").fill(recipient);
  await page.getByTestId("send-amount-input").fill(amount);

  const submit = page.getByTestId("send-submit");
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();

  const link = page.getByTestId("send-link");
  await link.waitFor({ timeout: 300_000 }); // the send is a multi-proof tx
  const text = (await link.textContent())?.trim();
  expect(text).toMatch(/^https?:\/\/.+#\/claim\//);
  return text as string;
}

/**
 * Navigate the recipient (warm session, onboarding modal already closed) to the claim link and
 * click Claim. The link differs from "/" only in the hash, so this is a same-document navigation —
 * no reload, the warm PXE is preserved — and the app's hashchange handler routes to the ClaimPage.
 */
async function openAndClaim(page: Page, link: string): Promise<void> {
  await page.goto(link);
  await page.getByTestId("claim-page").waitFor({ timeout: 60_000 });
  // Claim needs currentAddress; on a warm session it's already set, so this resolves immediately.
  await expect(async () => {
    const addr = await page.getByTestId("wallet-chip").getAttribute("data-address");
    expect(addr).toMatch(/^0x[0-9a-fA-F]+$/);
  }).toPass({ timeout: 60_000 });
  const claimBtn = page.getByTestId("claim-submit");
  await claimBtn.waitFor({ timeout: 30_000 });
  await claimBtn.click();
}

test.describe.serial("offchain send → receive", () => {
  test("sender delivers offchain; recipient claims", async ({ browser, baseURL }) => {
    test.setTimeout(20 * 60_000); // heavy: multiple client-side proofs across two embedded wallets

    const global = await readState<GlobalState>(STATE_FILES.global);
    const swap = await readState<SwapDeploymentState>(STATE_FILES.swapDeployment);
    console.log(`[e2e] node=${global.nodeUrl} goCoin=${swap.goCoin}`);

    const recipient = await newAppContext(browser, "recipient", baseURL);
    const sender = await newAppContext(browser, "sender", baseURL);
    try {
      // 1. Recipient onboards (no drip → 0 balance), dismisses the modal, exposes its address.
      await onboardEmbedded(recipient.page);
      await closeOnboardingModal(recipient.page);
      const recipientAddr = await readAddress(recipient.page);
      console.log(`[e2e] recipient=${recipientAddr}`);

      // 2. Sender onboards, drips GoCoin, sends N to the recipient.
      await onboardEmbedded(sender.page);
      await dripInModal(sender.page, swap.password);
      // LOAD-BEARING reload before the send — do NOT remove. The drip leaves background jobs in
      // flight on the sender's PXE; dispatching the heavy multi-proof send onto that busy PXE
      // deadlocks it (the send stalls after one proof and never produces the link). A full reload
      // resets the PXE so the send runs on a clean queue. The read below then waits for the PXE to
      // re-sync and re-register contracts before we send (else the send races registration and
      // throws "Contracts not initialized"). Do NOT reload *after* the send to read a balance —
      // that cold re-sync times out — the post-send read uses an in-app tab switch instead.
      await sender.page.goto("/");
      const senderBefore = await readGoCoinBalanceAfterReload(sender.page);
      const link = await sendOffchain(sender.page, recipientAddr, SEND_AMOUNT);
      console.log(`[e2e] claim link length=${link.length}`);

      // Sender parted with the tokens: its GoCoin dropped by at least the amount sent. Fees are
      // FPC-sponsored in fee juice (not GoCoin), so we assert ">= N" (not "== N") only because the
      // first send's subscribe path may consume some GoCoin — matching spec 05's directional-balance
      // convention. With the recipient gaining exactly N below, this is a conservation check. Read on
      // the warm post-send PXE via a tab switch (no reload); poll until the change note is reflected.
      const senderFrom = await gotoSwapTab(sender.page);
      await expect(async () => {
        const raw = (await senderFrom.getAttribute("data-balance")) ?? "";
        expect(raw).not.toBe("");
        expect(senderBefore - BigInt(raw)).toBeGreaterThanOrEqual(BigInt(SEND_AMOUNT));
      }).toPass({ timeout: 60_000 });

      // 3. Recipient claims — balance 0 → N, verified (warm session, hash-only nav to the claim route).
      await openAndClaim(recipient.page, link);
      await expect(recipient.page.getByTestId("claim-page")).toHaveAttribute(
        "data-phase",
        "claimed",
        { timeout: 300_000 },
      );
      await expect(recipient.page.getByTestId("claim-success")).toHaveAttribute(
        "data-verified",
        "true",
        { timeout: 10_000 },
      );
      // Return to the wallet UI (the app clears the #/claim hash WITHOUT reloading, preserving the
      // warm PXE + the note the claim just added) and confirm the tokens are actually held.
      await recipient.page.getByRole("button", { name: /back to app/i }).click();
      await assertGoCoinBalance(recipient.page, SEND_AMOUNT);
    } finally {
      await recipient.ctx.close();
      await sender.ctx.close();
    }
  });
});
