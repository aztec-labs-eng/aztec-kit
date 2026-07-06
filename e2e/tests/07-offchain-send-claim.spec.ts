import { type Browser, type BrowserContext, type Page } from "@playwright/test";
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

const APP = "http://localhost:5175";
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

/** Fresh isolated context (own OPFS/IndexedDB → own embedded wallet), pinned to local network. */
async function newAppContext(
  browser: Browser,
  tag: string,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: APP });
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

/** Close the onboarding modal (for actors that don't drip). CLOSE_MODAL keeps currentAddress/wallet;
 *  the open modal's backdrop would otherwise occlude the claim button after a hash-only navigation. */
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
  await page.goto(link);
  await page.getByTestId("claim-page").waitFor({ timeout: 60_000 });
  const claimBtn = page.getByTestId("claim-submit");
  await claimBtn.waitFor({ timeout: 30_000 });
  await claimBtn.click();
}

/** Reload the app and assert the GoCoin (swap-from) balance equals `expected`. */
async function assertGoCoinBalance(page: Page, expected: string): Promise<void> {
  await page.goto("/"); // clears the #/claim hash → main app, Swap tab (activeTab=0)
  const fromBox = page.getByTestId("swap-from");
  await fromBox.waitFor({ timeout: 30_000 });
  await expect(async () => {
    const raw = await fromBox.getAttribute("data-balance");
    expect(raw).toBe(expected); // "" = still loading; retries until resolved
  }).toPass({ timeout: 60_000 });
}

test.describe.serial("offchain send → claim", () => {
  test.slow();

  test("sender delivers offchain; recipient claims; intruder cannot", async ({ browser }) => {
    const global = await readState<GlobalState>(STATE_FILES.global);
    const swap = await readState<SwapDeploymentState>(STATE_FILES.swapDeployment);
    console.log(`[e2e] node=${global.nodeUrl} goCoin=${swap.goCoin}`);

    const recipient = await newAppContext(browser, "recipient");
    const sender = await newAppContext(browser, "sender");
    const intruder = await newAppContext(browser, "intruder");
    try {
      // 1. Recipient onboards; expose its address for the sender.
      await onboardEmbedded(recipient.page);
      const recipientAddr = await readAddress(recipient.page);
      console.log(`[e2e] recipient=${recipientAddr}`);
      await closeOnboardingModal(recipient.page);

      // 2. Sender onboards, drips GoCoin, sends N to the recipient.
      await onboardEmbedded(sender.page);
      await dripInModal(sender.page, swap.password);
      const link = await sendOffchain(sender.page, recipientAddr, SEND_AMOUNT);
      console.log(`[e2e] claim link length=${link.length}`);

      // 3. Recipient claims — balance 0 → N, verified.
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
      await assertGoCoinBalance(recipient.page, SEND_AMOUNT);

      // 4. Intruder opens the SAME link with a different wallet → never credited.
      //    The note is encrypted to the recipient, so the intruder can decrypt
      //    nothing. We assert the invariant (no credit / no verified success)
      //    without assuming whether the contract reverts or silently no-ops.
      await onboardEmbedded(intruder.page);
      await closeOnboardingModal(intruder.page);
      await openAndClaim(intruder.page, link);

      const intruderPhase = intruder.page.getByTestId("claim-page");
      await expect(intruderPhase).toHaveAttribute("data-phase", /^(claimed|error)$/, {
        timeout: 300_000,
      });
      if ((await intruderPhase.getAttribute("data-phase")) === "claimed") {
        await expect(intruder.page.getByTestId("claim-success")).toHaveAttribute(
          "data-verified",
          "false",
        );
      }
      await assertGoCoinBalance(intruder.page, "0");
    } finally {
      await recipient.ctx.close();
      await sender.ctx.close();
      await intruder.ctx.close();
    }
  });
});
