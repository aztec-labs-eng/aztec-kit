import { type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/test-base.ts";
import {
  readState,
  STATE_FILES,
  type GlobalState,
  type SwapDeploymentState,
} from "../fixtures/state.ts";

/**
 * Spec 07 — offchain delivery: send → claim between two embedded wallets.
 *
 *   1. Recipient onboards an embedded wallet (no drip → 0 balance), dismisses the
 *      onboarding modal, and exposes its L2 address via wallet-chip[data-address].
 *   2. Sender onboards, drips GoCoin, and sends N to the recipient via the Send tab,
 *      producing a shareable claim link (a real on-chain private tx; the recipient's
 *      note ciphertext rides in the link, not on-chain).
 *   3. Recipient opens the link (hash-only navigation — same document, warm PXE) and
 *      claims: balance 0 → N, verified. Combined with the sender's >= N debit this is
 *      a conservation check — the tokens moved, they weren't minted twice.
 *
 * Claiming is a local `offchain_receive` simulate (no on-chain tx, no fee), so the
 * recipient wallet needs no funding.
 *
 * Structure notes (each earned the hard way):
 * - NO reloads anywhere. Reloading restarts the PXE and forces a cold re-sync that
 *   times out balance reads; every read here happens on a warm PXE via in-app tab
 *   switches, mirroring spec 05's proven rhythm.
 * - FAIL FAST: every long wait races the app's error surface (send-error alert,
 *   claim-page data-phase="error"). This spec's early CI failures were a missing FPC
 *   signup whose error alert sat invisible behind a 300s link timeout, twice per run.
 *
 * Assumes specs 01-04 ran (deployed tokens + FPC signed up for
 * transfer_in_private_with_offchain_delivery — spec 04's signup 2c).
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

/**
 * Onboard an embedded wallet up to the awaiting_drip step. awaiting_drip means the
 * account exists (currentAddress set) and the balance query resolved to 0 — wallet ready.
 */
async function onboardEmbedded(page: Page): Promise<void> {
  await page.goto("/");
  const chip = page.getByTestId("wallet-chip");
  await chip.waitFor({ timeout: 60_000 });
  await expect(chip).toHaveAttribute("data-connected", "false", { timeout: 30_000 });
  await chip.click();

  const modal = page.getByTestId("onboarding-modal");
  await modal.waitFor({ timeout: 30_000 });
  await page.getByTestId("onboarding-use-embedded").click();
  await expect(modal).toHaveAttribute("data-status", "awaiting_drip", { timeout: 120_000 });
}

/**
 * Close the onboarding modal without dripping (marks onboarding complete, keeps the wallet).
 * The recipient never drips; dismissing the modal here means its backdrop won't occlude the
 * Claim button when the recipient later navigates to the claim route in the same warm session.
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

/** From the awaiting_drip modal: submit the password and wait for the modal to close (drip done). */
async function drip(page: Page, password: string): Promise<void> {
  const modal = page.getByTestId("onboarding-modal");
  const input = page.getByTestId("drip-password-input");
  await input.waitFor({ timeout: 10_000 });
  await input.fill(password);
  await page.getByTestId("drip-password-submit").click();
  // Modal auto-closes on drip success — the only stable terminal signal (see spec 05's note).
  await modal.waitFor({ state: "hidden", timeout: 300_000 });
}

/**
 * Read swap-from's GoCoin balance on the warm PXE, polling until it resolves to a positive
 * number. A resolved balance also proves the token contracts are registered (fetchBalances
 * needs them), so the subsequent send won't hit "Contracts not initialized".
 */
async function readGoCoinBalance(fromBox: Locator): Promise<bigint> {
  await expect(async () => {
    const raw = await fromBox.getAttribute("data-balance");
    expect(raw).not.toBe(""); // "" = still loading
    expect(raw).not.toBeNull();
    expect(BigInt(raw as string)).toBeGreaterThan(0n);
  }).toPass({ timeout: 60_000 });
  return BigInt((await fromBox.getAttribute("data-balance")) ?? "0");
}

/** Assert the Swap-tab GoCoin balance settles to `expected` (warm PXE — resolves quickly). */
async function assertGoCoinBalance(page: Page, expected: string): Promise<void> {
  await page.getByRole("tab", { name: "Swap" }).click();
  const fromBox = page.getByTestId("swap-from");
  await fromBox.waitFor({ timeout: 30_000 });
  await expect(async () => {
    expect(await fromBox.getAttribute("data-balance")).toBe(expected); // "" = loading; retries
  }).toPass({ timeout: 60_000 });
}

/** On the Send tab: send `amount` GoCoin to `recipient`, return the generated claim link. */
async function sendOffchain(page: Page, recipient: string, amount: string): Promise<string> {
  await page.getByRole("tab", { name: "Send" }).click();
  // The Send tab fetches balances on mount and the adornment renders once they hydrate.
  // Waiting for it before submitting mirrors spec 05's wait-for-hydration rhythm ahead of
  // firing a heavy tx.
  await page.getByTestId("send-balance").waitFor({ timeout: 60_000 });
  await page.getByTestId("send-recipient-input").fill(recipient);
  await page.getByTestId("send-amount-input").fill(amount);

  const submit = page.getByTestId("send-submit");
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();

  // Race the link against the send-error alert — see the FAIL FAST note in the docblock.
  const link = page.getByTestId("send-link");
  const sendError = page.getByTestId("send-error");
  await Promise.race([
    link.waitFor({ timeout: 300_000 }), // the send is a multi-proof tx
    sendError.waitFor({ state: "visible", timeout: 300_000 }).then(async () => {
      throw new Error(`send failed: ${await sendError.textContent()}`);
    }),
  ]);
  const text = (await link.textContent())?.trim();
  expect(text).toMatch(/^https?:\/\/.+#\/claim\//);
  return text as string;
}

/**
 * Navigate the recipient (warm session, onboarding modal already closed) to the claim link,
 * click Claim, and wait for a verified claim. The link differs from "/" only in the hash, so
 * this is a same-document navigation — no reload, the warm PXE is preserved — and the app's
 * hashchange handler routes to the ClaimPage.
 */
async function openAndClaim(page: Page, link: string): Promise<void> {
  await page.goto(link);
  const claimPage = page.getByTestId("claim-page");
  await claimPage.waitFor({ timeout: 60_000 });
  // Claim needs currentAddress; on a warm session it's already set, so this resolves quickly.
  await expect(async () => {
    const addr = await page.getByTestId("wallet-chip").getAttribute("data-address");
    expect(addr).toMatch(/^0x[0-9a-fA-F]+$/);
  }).toPass({ timeout: 60_000 });

  const claimBtn = page.getByTestId("claim-submit");
  await claimBtn.waitFor({ timeout: 30_000 });
  await claimBtn.click();

  // Wait for a terminal phase, then fail fast with the app's message if it's "error".
  await expect(claimPage).toHaveAttribute("data-phase", /^(claimed|error)$/, { timeout: 300_000 });
  if ((await claimPage.getAttribute("data-phase")) === "error") {
    throw new Error(`claim failed: ${await page.getByTestId("claim-error").textContent()}`);
  }
  await expect(page.getByTestId("claim-success")).toHaveAttribute("data-verified", "true", {
    timeout: 10_000,
  });
}

test.describe.serial("offchain send → claim", () => {
  test("sender delivers offchain; recipient claims and holds the tokens", async ({
    browser,
    baseURL,
  }) => {
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

      // 2. Sender onboards, drips, reads its pre-send balance on the warm PXE (Swap tab is
      //    the default landing tab), and sends N to the recipient.
      await onboardEmbedded(sender.page);
      await drip(sender.page, swap.password);
      const fromBox = sender.page.getByTestId("swap-from");
      await fromBox.waitFor({ timeout: 30_000 });
      const senderBefore = await readGoCoinBalance(fromBox);
      console.log(`[e2e] senderBefore=${senderBefore}`);

      const link = await sendOffchain(sender.page, recipientAddr, SEND_AMOUNT);
      console.log(`[e2e] claim link length=${link.length}`);

      // Sender parted with the tokens: GoCoin dropped by at least N. The debit is exactly N
      // for the transfer itself — ">= N" only because this send is the sender's first FPC
      // interaction for the transfer config, so it takes the subscribe (not sponsor) path,
      // which may itself consume GoCoin. Warm read via a tab switch; poll until the change
      // note is reflected.
      await sender.page.getByRole("tab", { name: "Swap" }).click();
      await fromBox.waitFor({ timeout: 30_000 });
      await expect(async () => {
        const raw = (await fromBox.getAttribute("data-balance")) ?? "";
        expect(raw).not.toBe("");
        expect(senderBefore - BigInt(raw)).toBeGreaterThanOrEqual(BigInt(SEND_AMOUNT));
      }).toPass({ timeout: 60_000 });

      // 3. Recipient claims — balance 0 → N, verified.
      await openAndClaim(recipient.page, link);
      // Return to the wallet UI (the app clears the #/claim hash WITHOUT reloading, preserving
      // the warm PXE + the note the claim just added) and confirm the tokens are actually held.
      await recipient.page.getByRole("button", { name: /back to app/i }).click();
      await assertGoCoinBalance(recipient.page, SEND_AMOUNT);
    } finally {
      await recipient.ctx.close();
      await sender.ctx.close();
    }
  });
});
