import { defineConfig, devices } from "@playwright/test";

/**
 * Project dependency graph (each edge is a `dependencies` link):
 *
 *   fpc-setup  →  bridge-fund  →  swap-deploy  →  fpc-signup  →  swap-flow
 *
 * - fpc-setup   (fpc-operator UI + bridge iframe) — creates fpc-admin + deploys FPC.
 * - bridge-fund (bridge UI) — funds swap-admin with fee juice.
 * - swap-deploy (node script) — runs swap-admin's deploy.ts with --payment feejuice.
 * - fpc-signup  (fpc-operator UI) — mints + registers contracts + 2× AppSignUp
 *                                   with calibration; writes swap's local.json.
 * - swap-flow   (swap UI) — end-user onboarding + sponsored swap + drip + send.
 *
 * The shared `aztec start --local-network`, L1 bridge deploy, and swap-admin
 * key derivation all happen in `globalSetup`.
 *
 * Environment toggles:
 *   E2E_HEADED=1       → headed browser (watch tests run)
 *   E2E_SLOW_MO=500    → slow down each action by N ms (implies headed)
 *   E2E_SKIP_NETWORK=1 → skip spawning `aztec start --local-network` in globalSetup;
 *                        assumes you already have one running
 */
const headed = process.env.E2E_HEADED === "1" || !!process.env.E2E_SLOW_MO;
const slowMo = process.env.E2E_SLOW_MO ? Number(process.env.E2E_SLOW_MO) : undefined;

const desktopChrome = { ...devices["Desktop Chrome"] };

function appServer(
  workspace: string,
  port: number,
): {
  command: string;
  url: string;
  reuseExistingServer: boolean;
  timeout: number;
  stdout: "pipe";
  stderr: "pipe";
} {
  return {
    command: `yarn workspace ${workspace} dev --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  };
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Separate Playwright's HTML reporter from our ad-hoc sidecar artifacts
  // (aztec.log written by local-network.ts). The HTML reporter wipes its
  // outputFolder on startup, which was eating aztec.log when both lived in
  // `playwright-report/`.
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "html-report" }]]
    : [["html", { outputFolder: "html-report" }]],
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  globalSetup: "./fixtures/global-setup.ts",
  globalTeardown: "./fixtures/global-teardown.ts",
  use: {
    // `retain-on-failure` keeps traces for failing attempts (including flakes
    // that later pass on retry). `on-first-retry` only captures the retry,
    // which is usually the passing run — less useful for debugging.
    trace: "retain-on-failure",
    video: "retain-on-failure",
    headless: !headed,
    launchOptions: slowMo ? { slowMo } : undefined,
  },
  projects: [
    {
      name: "fpc-setup",
      testMatch: /01-fpc-setup\.spec\.ts$/,
      use: { ...desktopChrome, baseURL: "http://localhost:5174" },
    },
    {
      name: "bridge-fund",
      testMatch: /02-bridge-fund-swap-admin\.spec\.ts$/,
      dependencies: ["fpc-setup"],
      use: { ...desktopChrome, baseURL: "http://localhost:5173" },
    },
    {
      name: "swap-deploy",
      testMatch: /03-swap-deploy\.spec\.ts$/,
      dependencies: ["bridge-fund"],
      // No baseURL — runs deploy.ts via child_process. Chromium still launches
      // (Playwright quirk) but the spec never navigates.
      use: desktopChrome,
    },
    {
      name: "fpc-signup",
      testMatch: /04-fpc-signup\.spec\.ts$/,
      dependencies: ["swap-deploy"],
      use: { ...desktopChrome, baseURL: "http://localhost:5174" },
    },
    {
      name: "swap-flow",
      testMatch: /05-swap-flow\.spec\.ts$/,
      dependencies: ["fpc-signup"],
      use: { ...desktopChrome, baseURL: "http://localhost:5175" },
    },
    {
      name: "wallet-encryption",
      testMatch: /06-wallet-encryption\.spec\.ts$/,
      // No dependencies: this test only needs the local Aztec network
      // (spawned by globalSetup) and the swap dev server. It doesn't
      // exercise any contract flows so the 01-05 setup chain is unnecessary.
      use: { ...desktopChrome, baseURL: "http://localhost:5175" },
    },
    {
      // Testnet iteration: runs the swap flow against the public Aztec
      // testnet (no local-network, no setup chain). Lets us profile the
      // caching-node-proxy against realistic network latency + an actively-
      // advancing chain. Requires the user to provide the testnet PoP
      // password via TESTNET_POP_PASSWORD (drip would otherwise fail) — the
      // test skip()s itself when the var is absent.
      //
      // Usage:
      //   TESTNET_POP_PASSWORD=… E2E_SKIP_NETWORK=1 yarn test --project=testnet-iter
      //
      // No `dependencies` and no global-setup-driven node spawn (the spec
      // sets E2E_SKIP_NETWORK internally if not set, and reads testnet
      // config from the swap app's bundled config).
      name: "testnet-iter",
      testMatch: /07-testnet-iteration\.spec\.ts$/,
      use: { ...desktopChrome, baseURL: "http://localhost:5175" },
    },
  ],
  webServer: [
    appServer("@aztec-kit/swap", 5175),
    appServer("@aztec-kit/bridge", 5173),
    appServer("@aztec-kit/fpc-operator", 5174),
  ],
});
