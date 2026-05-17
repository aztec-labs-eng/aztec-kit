import { type Page } from "@playwright/test";
import { test, expect } from "../fixtures/test-base.ts";

/**
 * Spec 07 — testnet iteration loop for the caching-node-proxy + tag warmer.
 *
 * Drives a full drip + swap flow against the public Aztec testnet so the
 * cache + warm-up can be validated under realistic latency + an actively-
 * advancing chain. Reads stats directly from `window.__nodeProxy.stats()`
 * at the assertion point (no auto-dump-cadence races).
 *
 * Prerequisites:
 *   - `TESTNET_POP_PASSWORD` env var: drip password (test skips without it).
 *   - The dev server must reach the testnet node URL in
 *     `apps/swap/src/config/networks/testnet.json`.
 *
 * Usage:
 *   TESTNET_POP_PASSWORD=… E2E_SKIP_NETWORK=1 yarn test --project=testnet-iter
 */

const TESTNET_PASSWORD = process.env.TESTNET_POP_PASSWORD ?? "";
const FROM_AMOUNT = "1";

async function openOnboardingTestnet(page: Page): Promise<void> {
  // Force-select testnet BEFORE any script runs so the wallet boots
  // against the right node.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("goswap_network", "testnet");
    } catch {
      /* ignore */
    }
  });
  await page.goto("/");
  const walletChip = page.getByTestId("wallet-chip");
  await walletChip.waitFor({ timeout: 60_000 });
  await expect(walletChip).toHaveAttribute("data-connected", "false", { timeout: 30_000 });
  await walletChip.click();
}

test.describe.serial("testnet iteration", () => {
  test.slow();

  test("full swap flow: warm + cache hits during sim+prove", async ({ page }) => {
    test.skip(
      !TESTNET_PASSWORD,
      "TESTNET_POP_PASSWORD env var is required (the password set when testnet contracts were deployed).",
    );

    await openOnboardingTestnet(page);

    // ── 1. Pick embedded wallet ──────────────────────────────────────
    const modal = page.getByTestId("onboarding-modal");
    await modal.waitFor({ timeout: 30_000 });
    await page.getByTestId("onboarding-use-embedded").click();

    // ── 2. Drip (testnet PoP password) ───────────────────────────────
    const tBoot = Date.now();
    await expect(modal).toHaveAttribute("data-status", "awaiting_drip", { timeout: 180_000 });
    const bootMs = Date.now() - tBoot;
    console.log(`[testnet-iter] boot → awaiting_drip: ${bootMs}ms`);

    const dripInput = page.getByTestId("drip-password-input");
    await dripInput.waitFor({ timeout: 10_000 });
    await dripInput.fill(TESTNET_PASSWORD);
    await page.getByTestId("drip-password-submit").click();
    await modal.waitFor({ state: "hidden", timeout: 300_000 });

    // ── 3. Swap ─────────────────────────────────────────────────────
    const swapContainer = page.getByTestId("swap-container");
    await swapContainer.waitFor({ timeout: 30_000 });

    const fromBox = page.getByTestId("swap-from");
    await expect(async () => {
      const raw = await fromBox.getAttribute("data-balance");
      expect(raw).not.toBe("");
      expect(raw).not.toBeNull();
      expect(BigInt(raw as string)).toBeGreaterThan(0n);
    }).toPass({ timeout: 120_000 });

    await page.getByTestId("swap-from-input").fill(FROM_AMOUNT);
    const submit = page.getByTestId("swap-submit");
    await expect(submit).toBeEnabled({ timeout: 60_000 });

    const tClick = Date.now();
    const statsAtClick = await page.evaluate(() => {
      const i = (window as unknown as { __nodeProxy?: { stats: () => unknown } }).__nodeProxy;
      return i ? i.stats() : null;
    });
    await submit.click();
    await page.evaluate(async () => {
      const el = document.querySelector('[data-testid="swap-container"]') as HTMLElement | null;
      if (!el) return;
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const phase = el.getAttribute("data-phase");
        if (phase === "success" || phase === "error") return;
        await new Promise((r) => setTimeout(r, 100));
      }
    });
    const finalPhase = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="swap-container"]') as HTMLElement | null;
      return el?.getAttribute("data-phase") ?? null;
    });
    console.log(
      `[testnet-iter] click → ${finalPhase} in ${Date.now() - tClick}ms` +
        (finalPhase === "error"
          ? " (likely testnet CORS on sendTx — sim+prove still measured)"
          : ""),
    );

    // ── 4. Per-method swap deltas ────────────────────────────────────
    const live = await page.evaluate(() => {
      const i = (window as unknown as { __nodeProxy?: { stats: () => unknown } }).__nodeProxy;
      return i ? i.stats() : null;
    });
    expect(live, "no live proxy stats — inspect=true didn't propagate?").not.toBeNull();
    type StatsShape = {
      methods: Record<
        string,
        {
          calls: number;
          hits: number;
          misses: number;
          upstream: number;
          elements?: { hits: number; seen: number };
        }
      >;
    };
    const typed = live as StatsShape;
    const baseline = statsAtClick as StatsShape | null;

    function deltaFor(name: string): {
      calls: number;
      hits: number;
      misses: number;
      upstream: number;
    } {
      const after = typed.methods[name];
      const before = baseline?.methods?.[name];
      return {
        calls: (after?.calls ?? 0) - (before?.calls ?? 0),
        hits: (after?.hits ?? 0) - (before?.hits ?? 0),
        misses: (after?.misses ?? 0) - (before?.misses ?? 0),
        upstream: (after?.upstream ?? 0) - (before?.upstream ?? 0),
      };
    }

    console.log("[testnet-iter] SWAP-ONLY stats (click → end-of-sim+prove):");
    let totalSwapUpstream = 0;
    for (const m of [
      "getPrivateLogsByTags",
      "getTxReceipt",
      "getTxEffect",
      "getPublicStorageAt",
      "findLeavesIndexes",
      "getNullifierMembershipWitness",
      "getNoteHashMembershipWitness",
      "getPublicDataWitness",
    ]) {
      const d = deltaFor(m);
      if (d.calls === 0) continue;
      const rate = d.calls > 0 ? Math.round((d.hits / d.calls) * 100) : 0;
      console.log(
        `  ${m.padEnd(36)} calls=${String(d.calls).padStart(3)} hits=${String(d.hits).padStart(3)}` +
          ` miss=${String(d.misses).padStart(3)} up=${String(d.upstream).padStart(3)} hitRate=${rate}%`,
      );
      totalSwapUpstream += d.upstream;
    }
    console.log(
      `[testnet-iter] swap upstream RPCs: ${totalSwapUpstream} (~${Math.round(totalSwapUpstream * 0.14)}s of network at 140ms/call)`,
    );

    // Hard assertions on cache effectiveness during the swap. We assert
    // on receipts + effects because tag queries are polluted by warm
    // batches that fire during the swap window (populating new
    // contracts) — without warm-vs-PXE attribution the delta-call
    // metric is misleading there. Receipts + effects have no such
    // pollution: every call originates from PXE.
    const receiptDelta = deltaFor("getTxReceipt");
    const effectDelta = deltaFor("getTxEffect");
    const receiptRate =
      receiptDelta.calls > 0 ? receiptDelta.hits / receiptDelta.calls : 0;
    const effectRate =
      effectDelta.calls > 0 ? effectDelta.hits / effectDelta.calls : 0;
    expect(
      receiptRate,
      `getTxReceipt hit rate during swap ${Math.round(receiptRate * 100)}% < 70% — receipt pre-warm from harvested log txHashes broke`,
    ).toBeGreaterThanOrEqual(0.7);
    expect(
      effectRate,
      `getTxEffect hit rate during swap ${Math.round(effectRate * 100)}% < 70% — effect pre-warm from harvested log txHashes broke`,
    ).toBeGreaterThanOrEqual(0.7);
  });
});
