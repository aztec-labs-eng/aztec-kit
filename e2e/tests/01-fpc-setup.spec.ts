import { type Frame } from "@playwright/test";
import { test, expect } from "../fixtures/test-base.ts";
import { readFile } from "node:fs/promises";
import {
  writeState,
  readState,
  hasState,
  STATE_FILES,
  type GlobalState,
  type FpcState,
} from "../fixtures/state.ts";
import { injectL1Wallet, ANVIL_DEV_KEY } from "../fixtures/inject-l1-wallet.ts";
import { pumpL2Blocks } from "../fixtures/pump-l2-blocks.ts";

/**
 * Spec 01 — fpc-dashboard setup.
 *
 * Drives the real fpc-dashboard UI through its SetupWizard:
 *   1. wait for step 1 "Deploy Admin & FPC" to activate
 *   2. bridge iframe mints+bridges via faucet, advances L1→L2, claims
 *   3. click "Deploy FPC"
 *   4. land on the Dashboard, click Settings tab, verify Export Backup button
 *
 * Signals come from data-testid attributes on the products under test
 * (fpc-dashboard, bridge) plus a direct read of the bridge app's session
 * localStorage to know when the L1→L2 pump window is open — no UI-text
 * matching or timing guesses.
 *
 * Still TODO:
 *   - click Export Backup + capture the JSON download
 *   - persist fpc-admin secret + fpc address to fpc.json
 */

/** Session key used by the bridge app to persist wizard progress. */
const BRIDGE_SESSION_KEY = "gobridge_session";

/** Reads the bridge-iframe session phase. Returns null if no session. */
async function getBridgeSessionPhase(
  frame: Frame,
): Promise<"l1-pending" | "bridged" | "claiming" | null> {
  return frame.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { phase?: string };
      const p = parsed.phase;
      if (p === "l1-pending" || p === "bridged" || p === "claiming") return p;
      return null;
    } catch {
      return null;
    }
  }, BRIDGE_SESSION_KEY);
}

test.describe.serial("fpc-dashboard setup", () => {
  test.slow();

  test("deploys a SubscriptionFPC via the real UI", async ({ page }) => {
    test.skip(hasState(STATE_FILES.fpc), `checkpoint exists at ${STATE_FILES.fpc}`);
    const global = await readState<GlobalState>(STATE_FILES.global);

    await injectL1Wallet(page, {
      privateKey: ANVIL_DEV_KEY,
      rpcUrl: global.l1RpcUrl,
      chainId: global.chainId,
    });

    // Pre-seed the network selection so fpc-dashboard targets `local`
    // instead of the default `testnet`. The bridge iframe inherits the
    // network id via the `?network=local` query param the dashboard injects.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("aztec_kit_network", "local");
      } catch {
        /* ignore */
      }
    });

    await page.goto("/");

    // ── Step 1: bridge ────────────────────────────────────────────────
    const wizard = page.getByTestId("setup-wizard");
    await expect(wizard).toHaveAttribute("data-active-step", "1", { timeout: 90_000 });

    const bridge = page.frameLocator('iframe[src*="localhost:5173"]');
    const bridgeButton = bridge.getByTestId("bridge-submit");
    await expect(bridgeButton).toBeEnabled({ timeout: 60_000 });
    await bridgeButton.click();

    // Wait until the bridge session advances to `bridged` (L1 landed,
    // awaiting L1→L2 message sync), then pump until sync completes.
    const bridgeFrame = page.frames().find((f) => f.url().includes("localhost:5173"));
    if (!bridgeFrame) throw new Error("bridge iframe not attached");

    await expect(async () => {
      const phase = await getBridgeSessionPhase(bridgeFrame);
      expect(phase === "bridged" || phase === "claiming").toBe(true);
    }).toPass({ timeout: 60_000 });

    const postPhase = bridge.getByTestId("bridge-post-phase");
    const stopPump = await pumpL2Blocks({
      nodeUrl: global.nodeUrl,
      l1RpcUrl: global.l1RpcUrl,
    });
    try {
      await expect(postPhase).toHaveAttribute("data-l2-synced", "true", { timeout: 180_000 });
    } finally {
      await stopPump();
    }

    // ── Step 2: deploy FPC ────────────────────────────────────────────
    // Once the bridge finishes claiming, fpc-dashboard collapses Step 1
    // (including the iframe) and advances to Step 2. Watch the outer
    // wizard's step attribute — the iframe's post-phase attributes would
    // unmount during the transition.
    await expect(wizard).toHaveAttribute("data-active-step", "2", { timeout: 180_000 });

    const deployBtn = page.getByTestId("setup-deploy-fpc");
    await expect(deployBtn).toBeEnabled({ timeout: 30_000 });
    await deployBtn.click();

    const dashboard = page.getByTestId("dashboard");
    const deployError = page.getByTestId("setup-deploy-error");
    await Promise.race([
      dashboard.waitFor({ state: "visible", timeout: 180_000 }),
      deployError.waitFor({ state: "visible", timeout: 180_000 }).then(async () => {
        const msg = await deployError.textContent();
        throw new Error(`Deploy FPC failed: ${msg ?? "(no message)"}`);
      }),
    ]);

    // ── Settings tab → Export Backup ─────────────────────────────────
    await page.getByTestId("tab-settings").click();
    const exportBtn = page.getByTestId("backup-export");
    await expect(exportBtn).toBeVisible();

    // Clicking Export triggers an anchor-based download via Blob URL. We
    // capture it through Playwright's download event, persist the JSON to
    // e2e/.state/, and extract the admin + fpc details into fpc.json so
    // downstream specs can restore the same identity without re-running
    // the setup wizard.
    const downloadPromise = page.waitForEvent("download");
    await exportBtn.click();
    const download = await downloadPromise;
    await download.saveAs(STATE_FILES.fpcBackup);

    const backup = JSON.parse(await readFile(STATE_FILES.fpcBackup, "utf-8")) as {
      admin: { address: string; secretKey: string };
      fpc: { address: string } | null;
    };
    if (!backup.fpc) throw new Error("Backup JSON has no fpc entry — deploy must have failed");

    const fpc: FpcState = {
      fpcAddress: backup.fpc.address,
      fpcAdminAddress: backup.admin.address,
      fpcAdminSecretKey: backup.admin.secretKey,
    };
    await writeState(STATE_FILES.fpc, fpc);
    console.log(`[e2e] wrote ${STATE_FILES.fpc} (fpc=${fpc.fpcAddress})`);
  });
});
