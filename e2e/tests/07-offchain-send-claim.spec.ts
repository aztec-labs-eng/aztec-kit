import { type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/test-base.ts";
import {
  readState,
  STATE_FILES,
  type GlobalState,
  type SwapDeploymentState,
} from "../fixtures/state.ts";

/**
 * Spec 07 — offchain delivery: send → claim.
 *
 *   1. Recipient onboards an embedded wallet (0 balance) and exposes its
 *      L2 address via wallet-chip[data-address].
 *   2. Sender onboards, drips GoCoin, and sends N to the recipient via the
 *      Send tab, producing a shareable claim link.
 *   3. Recipient opens the link and claims — balance goes 0 → N, verified.
 *   4. (Task 3) Intruder opens the same link and cannot claim.
 *
 * Claiming is a local `offchain_receive` simulate (no on-chain tx, no fee),
 * so recipient/intruder wallets need no funding. Assumes specs 01-04 ran
 * (deployed tokens + FPC signed up for transfer_in_private_with_offchain_delivery).
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
  // the balance query resolved to 0 — the wallet is safe to read/persist.
  await expect(modal).toHaveAttribute("data-status", "awaiting_drip", { timeout: 120_000 });
}

/**
 * Park a page on about:blank so its embedded-wallet PXE stops running — freeing CI CPU + the
 * shared node for whichever actor is proving. Multiple live PXEs contend and stall the (heavy)
 * send. Parking also makes the next `page.goto(claimLink)` a FULL load rather than a hash-only
 * no-op: the wallet auto-restores from OPFS on arrival, and the onboarding modal (which only
 * re-opens on an explicit chip click) is absent — so it can't occlude the Claim button.
 */
async function park(page: Page): Promise<void> {
  await page.goto("about:blank");
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

/** On the Send tab: send `amount` GoCoin to `recipient`, return the generated claim link. */
async function sendOffchain(page: Page, recipient: string, amount: string): Promise<string> {
  await page.getByRole("tab", { name: "Send" }).click();
  await page.getByTestId("send-recipient-input").fill(recipient);
  await page.getByTestId("send-amount-input").fill(amount);

  const submit = page.getByTestId("send-submit");
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();

  const link = page.getByTestId("send-link");
  await link.waitFor({ timeout: 300_000 });
  const text = (await link.textContent())?.trim();
  expect(text).toMatch(/^https?:\/\/.+#\/claim\//);
  return text as string;
}

/** Navigate to a claim link and click Claim (leaves the page in a claiming/verifying/claimed/error phase). */
async function openAndClaim(page: Page, link: string): Promise<void> {
  await page.goto(link); // full load (page was parked) → wallet restores from OPFS
  await page.getByTestId("claim-page").waitFor({ timeout: 60_000 });
  // The claim needs currentAddress, which restores asynchronously on this fresh load.
  // Wait for the chip's address to populate before clicking (spec 06's restore signal).
  await expect(async () => {
    const addr = await page.getByTestId("wallet-chip").getAttribute("data-address");
    expect(addr).toMatch(/^0x[0-9a-fA-F]+$/);
  }).toPass({ timeout: 120_000 });
  const claimBtn = page.getByTestId("claim-submit");
  await claimBtn.waitFor({ timeout: 30_000 });
  await claimBtn.click();
}

/**
 * Switch to the Swap tab and return swap-from's locator. Uses an in-app tab click,
 * NOT `page.goto("/")` — a full reload cold-restarts the embedded wallet's PXE, whose
 * re-sync after a send tx blows the balance-poll timeout. The tab switch keeps the
 * warm, already-synced PXE (this is how spec 05 reads balances too). Requires the
 * tabbed app to be showing (not the onboarding modal or the #/claim route).
 */
async function gotoSwapTab(page: Page): Promise<Locator> {
  await page.getByRole("tab", { name: "Swap" }).click();
  const fromBox = page.getByTestId("swap-from");
  await fromBox.waitFor({ timeout: 30_000 });
  return fromBox;
}

/** Resolved GoCoin (swap-from) balance from the Swap tab. */
async function readGoCoinBalance(page: Page): Promise<bigint> {
  const fromBox = await gotoSwapTab(page);
  let raw = "";
  await expect(async () => {
    raw = (await fromBox.getAttribute("data-balance")) ?? "";
    expect(raw).not.toBe(""); // "" = still loading; retries until resolved
  }).toPass({ timeout: 60_000 });
  return BigInt(raw);
}

/** Assert the Swap-tab GoCoin balance settles to `expected`. */
async function assertGoCoinBalance(page: Page, expected: string): Promise<void> {
  const fromBox = await gotoSwapTab(page);
  await expect(async () => {
    expect(await fromBox.getAttribute("data-balance")).toBe(expected); // "" = loading; retries
  }).toPass({ timeout: 60_000 });
}

test.describe.serial("offchain send → claim", () => {
  test.slow();

  test("sender delivers offchain; recipient claims; intruder cannot", async ({
    browser,
    baseURL,
  }) => {
    const global = await readState<GlobalState>(STATE_FILES.global);
    const swap = await readState<SwapDeploymentState>(STATE_FILES.swapDeployment);
    console.log(`[e2e] node=${global.nodeUrl} goCoin=${swap.goCoin}`);

    const recipient = await newAppContext(browser, "recipient", baseURL);
    const sender = await newAppContext(browser, "sender", baseURL);
    const intruder = await newAppContext(browser, "intruder", baseURL);
    try {
      // Only ONE embedded-wallet PXE runs at a time: each actor is parked on about:blank
      // while another proves. Concurrent PXEs contend for CI CPU + the shared node and
      // stall the heavy send (an earlier all-live-at-once version timed out mid-send).

      // 1. Recipient onboards, exposes its address, then parks (idle during the send).
      await onboardEmbedded(recipient.page);
      const recipientAddr = await readAddress(recipient.page);
      console.log(`[e2e] recipient=${recipientAddr}`);
      await park(recipient.page);

      // 2. Sender onboards, drips GoCoin, sends N to the recipient.
      await onboardEmbedded(sender.page);
      await dripInModal(sender.page, swap.password);
      const senderBefore = await readGoCoinBalance(sender.page);
      const link = await sendOffchain(sender.page, recipientAddr, SEND_AMOUNT);
      console.log(`[e2e] claim link length=${link.length}`);

      // Sender parted with the tokens: its GoCoin dropped by at least the amount
      // sent. Fees are FPC-sponsored in fee juice (not GoCoin), so we assert ">= N"
      // rather than "== N" only because the first send's subscribe path may consume
      // some GoCoin — matching spec 05's directional-balance convention. Together
      // with the recipient gaining exactly N below, this is a conservation check:
      // tokens moved, not minted. Poll until the change note is reflected.
      const senderFrom = await gotoSwapTab(sender.page);
      await expect(async () => {
        const raw = (await senderFrom.getAttribute("data-balance")) ?? "";
        expect(raw).not.toBe("");
        expect(senderBefore - BigInt(raw)).toBeGreaterThanOrEqual(BigInt(SEND_AMOUNT));
      }).toPass({ timeout: 60_000 });
      await park(sender.page); // idle during the recipient's claim

      // 3. Recipient claims — the only active PXE; its wallet restores from OPFS.
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
      // Return to the wallet UI (the app clears the #/claim hash WITHOUT reloading,
      // so the warm PXE + the note the claim just added are preserved) and confirm
      // the tokens are actually held, not only reported by the claim's own check.
      await recipient.page.getByRole("button", { name: /back to app/i }).click();
      await assertGoCoinBalance(recipient.page, SEND_AMOUNT);
      await park(recipient.page); // idle during the intruder

      // 4. Intruder opens the SAME link with a different wallet → never credited.
      //    The note is encrypted to the recipient, so the intruder can decrypt
      //    nothing. We assert the invariant (no credit / no verified success)
      //    without assuming whether the contract reverts or silently no-ops.
      //    Park after onboarding so the claim opens via a full load (fresh wallet
      //    restore, no leftover onboarding modal).
      await onboardEmbedded(intruder.page);
      await park(intruder.page);
      await openAndClaim(intruder.page, link);

      const intruderPhase = intruder.page.getByTestId("claim-page");
      await expect(intruderPhase).toHaveAttribute("data-phase", /^(claimed|error)$/, {
        timeout: 300_000,
      });
      if ((await intruderPhase.getAttribute("data-phase")) === "claimed") {
        // verified = (balanceAfter - balanceBefore) >= N, measured by the app. The
        // intruder can decrypt nothing, so received is 0 → verified is false. That IS
        // the not-credited invariant; a separate balance read would be redundant (and
        // couldn't run from the `error` branch, which has no way back to the app UI).
        await expect(intruder.page.getByTestId("claim-success")).toHaveAttribute(
          "data-verified",
          "false",
        );
      }
    } finally {
      await recipient.ctx.close();
      await sender.ctx.close();
      await intruder.ctx.close();
    }
  });
});
