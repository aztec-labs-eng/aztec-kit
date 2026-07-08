import { type Locator, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/test-base.ts";
import {
  readState,
  STATE_FILES,
  type GlobalState,
  type SwapDeploymentState,
} from "../fixtures/state.ts";

/**
 * Spec 07 — offchain delivery, send side only.
 *
 * One embedded wallet onboards, drips GoCoin, then does an offchain send of N to a
 * distinct recipient address. We assert the sender's GoCoin balance dropped by exactly
 * N — the tokens left its private balance (they didn't just get re-minted or bounce back).
 *
 * Why the recipient needs no wallet: the app takes the recipient as a bare address string
 * (`AztecAddress.fromStringUnsafe`) and the token's `transfer_in_private_with_offchain_delivery`
 * encrypts the note to that address's point and hands the ciphertext back for offchain
 * delivery in a link. The sender's PXE never needs the recipient's keys or a live PXE behind
 * the address — so we send to the already-deployed swap-admin address from state instead of
 * standing up a second embedded wallet (halves the proving cost and the node load).
 *
 * The claim side is deliberately out of scope here — this spec isolates and stabilizes the
 * send before layering claim back on.
 *
 * Structure mirrors spec 05 (swap-flow): a single embedded wallet, drip → heavy tx on the
 * SAME warm PXE with NO reload in between. Spec 05 proves that pattern is stable for a
 * multi-proof FPC-sponsored tx (its swap); the offchain send is the same weight class.
 * (An earlier two-wallet version reloaded after the drip to dodge PXE contention; that
 * reload forced a cold re-sync that was the real source of the flakiness. One wallet, no
 * reload, warm reads throughout.)
 *
 * FAIL FAST — the send's link wait races the app's send-error alert, so a failing send
 * surfaces its actual error message in seconds instead of burning the 300s link timeout.
 * (This spec's first CI failures were a missing FPC signup — "No subscription config
 * found" — that sat invisible in exactly that alert while the test waited out the full
 * timeout, twice per run. Spec 04 now signs the transfer function up.)
 *
 * Assumes specs 01-04 ran (deployed tokens + FPC signed up for
 * transfer_in_private_with_offchain_delivery — spec 04's signup 2c).
 */

const SEND_AMOUNT = "5";

/** Seed the local network key, load the app, and open the onboarding modal (spec 05's opener). */
async function openOnboarding(page: Page): Promise<void> {
  // Seed the active network BEFORE any script runs so the app picks local, not testnet.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("goswap_network", "local");
    } catch {
      /* ignore */
    }
  });

  await page.goto("/");

  const walletChip = page.getByTestId("wallet-chip");
  await walletChip.waitFor({ timeout: 60_000 });
  await expect(walletChip).toHaveAttribute("data-connected", "false", { timeout: 30_000 });
  await walletChip.click();

  const modal = page.getByTestId("onboarding-modal");
  await modal.waitFor({ timeout: 30_000 });
  await page.getByTestId("onboarding-use-embedded").click();
}

/** From the awaiting_drip modal: submit the password and wait for the modal to close (drip done). */
async function drip(page: Page, password: string): Promise<void> {
  const modal = page.getByTestId("onboarding-modal");
  await expect(modal).toHaveAttribute("data-status", "awaiting_drip", { timeout: 120_000 });

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

test.describe.serial("offchain send", () => {
  test.slow(); // heavy: two multi-proof txs (drip + send) on a client-side prover

  test("sender delivers an offchain transfer; its GoCoin balance is debited", async ({ page }) => {
    const global = await readState<GlobalState>(STATE_FILES.global);
    const swap = await readState<SwapDeploymentState>(STATE_FILES.swapDeployment);

    // A distinct, already-deployed, guaranteed-valid recipient — no second wallet needed.
    const recipient = global.swapAdmin.address;
    console.log(`[e2e] node=${global.nodeUrl} goCoin=${swap.goCoin} recipient=${recipient}`);

    // 1. Onboard the embedded wallet and drip GoCoin.
    await openOnboarding(page);
    await drip(page, swap.password);

    // 2. Read the post-drip balance on the warm PXE (Swap tab is the default landing tab).
    const fromBox = page.getByTestId("swap-from");
    await fromBox.waitFor({ timeout: 30_000 });
    const senderBefore = await readGoCoinBalance(fromBox);
    console.log(`[e2e] senderBefore=${senderBefore}`);

    // 3. Send N offchain to the recipient.
    const link = await sendOffchain(page, recipient, SEND_AMOUNT);
    console.log(`[e2e] claim link length=${link.length}`);

    // 4. The sender parted with the tokens: its GoCoin dropped by at least N. The N sent left its
    //    private balance as a note owned by the recipient (delivered offchain in the link) while
    //    its own change note was self-delivered, so the debit is exactly N — EXCEPT this send is
    //    the sender's first FPC interaction for the transfer function's config, so it takes the
    //    subscribe (not sponsor) path, which may itself consume some GoCoin. Hence ">= N", matching
    //    spec 05's directional-balance convention. Read on the same warm PXE via a tab switch (no
    //    reload); poll until the change note is reflected.
    await page.getByRole("tab", { name: "Swap" }).click();
    await fromBox.waitFor({ timeout: 30_000 });
    await expect(async () => {
      const raw = (await fromBox.getAttribute("data-balance")) ?? "";
      expect(raw).not.toBe("");
      expect(senderBefore - BigInt(raw)).toBeGreaterThanOrEqual(BigInt(SEND_AMOUNT));
    }).toPass({ timeout: 60_000 });
  });
});
