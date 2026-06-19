import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";
import { Fr } from "@aztec/foundation/curves/bn254";
import {
  setupLocalNetworkCli,
  setupWallet,
  getAdmin,
  getSalt,
  type LocalNetworkCli,
} from "@aztec-kit/common/testing";
import { deployL1Bridge } from "@aztec-kit/contracts-ethereum";
import {
  resetStateDir,
  ensureStateDir,
  writeState,
  readState,
  hasState,
  STATE_FILES,
  type GlobalState,
} from "./state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

/**
 * Runs before any spec. Produces the baseline stack used by every spec:
 *   1. `aztec start --local-network` (unless E2E_SKIP_NETWORK=1)
 *   2. L1 bridge contract deployed (via CREATE2, idempotent — always at the
 *      same deterministic address)
 *   3. Deterministic swap-admin identity derived
 *   4. `e2e/.state/global.json` written
 *
 * Runs are incremental by default: if `.state/` already contains checkpoints
 * from a previous run, they are preserved so per-spec re-runs don't redo
 * the 5-minute bridge + deploy chain. Pass `E2E_RESET=1` (or run
 * `yarn e2e:reset`) to wipe `.state/` and start fresh.
 *
 * `global.json` itself is re-derived on every run: it's cheap (L1 CREATE2
 * check + an ephemeral PXE to compute an address) and the chain id might
 * change between `aztec start` invocations.
 */
export default async function globalSetup(_config: FullConfig): Promise<void> {
  if (process.env.E2E_RESET === "1") {
    console.log("[e2e] E2E_RESET=1 — wiping .state/");
    await resetStateDir();
  } else {
    await ensureStateDir();
  }

  // Make sure bridge + fpc-operator have a local.json before their dev
  // servers boot — without it they'd default to testnet and the iframe
  // handshake would fail. swap's local.json is produced by spec 03.
  console.log("[e2e] bootstrapping local network configs (bridge + fpc-operator)...");
  const bootstrap = spawnSync("node", [resolve(REPO_ROOT, "scripts/bootstrap-local-networks.js")], {
    stdio: "inherit",
  });
  if (bootstrap.status !== 0) {
    throw new Error(`bootstrap-local-networks.js exited with code ${bootstrap.status}`);
  }

  if (process.env.E2E_SKIP_NETWORK === "1") {
    console.log("[e2e] E2E_SKIP_NETWORK=1 — skipping local-network startup");
  } else {
    const network = await setupLocalNetworkCli({
      logDir: resolve(HERE, "..", "playwright-report"),
    });
    (globalThis as unknown as { __gjNetwork: LocalNetworkCli }).__gjNetwork = network;
    console.log(`[e2e] local-network ready (node=${network.nodeUrl} l1=${network.l1RpcUrl})`);
  }

  // Reuse global.json from a previous run if it's still valid (same node
  // URL + chain id). Swap-admin + L1 bridge addresses are deterministic so
  // they'll match — but if anything drifts we fall back to re-deriving.
  if (hasState(STATE_FILES.global)) {
    try {
      const existing = await readState<GlobalState>(STATE_FILES.global);
      const expectedNodeUrl = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
      const expectedL1RpcUrl = process.env.ETHEREUM_HOST ?? "http://localhost:8545";
      if (existing.nodeUrl === expectedNodeUrl && existing.l1RpcUrl === expectedL1RpcUrl) {
        console.log(
          `[e2e] reusing ${STATE_FILES.global} (swap-admin=${existing.swapAdmin.address})`,
        );
        return;
      }
      console.log("[e2e] global.json stale (node/L1 URL changed) — re-deriving");
    } catch (err) {
      console.log(`[e2e] global.json unreadable, re-deriving: ${(err as Error).message}`);
    }
  }

  const nodeUrl = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  const l1RpcUrl = process.env.ETHEREUM_HOST ?? "http://localhost:8545";

  console.log("[e2e] deploying L1 bridge contract (CREATE2)...");
  const l1BridgeAddress = await deployL1Bridge({ chainName: "anvil", rpcUrl: l1RpcUrl });
  console.log(`[e2e] L1 bridge at ${l1BridgeAddress}`);

  // Establish the swap-admin identity here (the first step that needs it) and write it all down:
  // a fresh per-run secret + the salt (operator-overridable via SALT, else Fr(0)) + the derived
  // address. All three go to global.json and are forwarded — spec 02 funds the address, spec 03
  // deploys with the secret AND this salt — so the deployed-from address matches by construction.
  console.log("[e2e] deriving swap-admin identity...");
  const swapAdminSecret = Fr.random();
  const swapAdminSalt = getSalt();
  const { wallet } = await setupWallet(nodeUrl, "local");
  const swapAdminAddress = await getAdmin(wallet, swapAdminSecret, swapAdminSalt);
  const swapAdmin = {
    secret: swapAdminSecret.toString(),
    salt: swapAdminSalt.toString(),
    address: swapAdminAddress.toString(),
  };
  console.log(`[e2e] swap-admin address: ${swapAdmin.address}`);

  const state: GlobalState = {
    nodeUrl,
    l1RpcUrl,
    chainId: 31337,
    l1BridgeAddress,
    swapAdmin,
  };
  await writeState(STATE_FILES.global, state);
  console.log(`[e2e] wrote ${STATE_FILES.global}`);
}
