/**
 * Shared on-disk state for e2e specs.
 *
 * Each setup phase writes to its own file under `e2e/.state/`, and later specs
 * (possibly running in a different Playwright project) read what they need.
 * Kept as plain files so debugging a failed run is a matter of catting a file
 * rather than inspecting Playwright's worker state.
 *
 * ── Checkpointing ──────────────────────────────────────────────────────────
 * Runs are incremental only when `E2E_SKIP_NETWORK=1` is set and the caller is
 * reusing an already-running local network. If global setup starts a fresh
 * local-network, it wipes these files because old L2 contract addresses will
 * not exist on the new chain.
 *
 * To start from scratch, run with `E2E_RESET=1` (or delete `e2e/.state/`
 * manually — the `yarn e2e:reset` script does this).
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..");
export const STATE_DIR = resolve(ROOT, ".state");

export const STATE_FILES = {
  /** Written by global-setup: node URLs, chain id, L1 bridge, swap-admin. */
  global: resolve(STATE_DIR, "global.json"),
  /** Written by spec 01 (fpc-dashboard setup): fpc-admin + FPC details. */
  fpc: resolve(STATE_DIR, "fpc-setup.json"),
  /** Written by spec 01: the backup JSON exported from the fpc-dashboard. */
  fpcBackup: resolve(STATE_DIR, "fpc-backup.json"),
  /** Written by spec 02 (bridge-fund): marker that swap-admin has FJ on L2. */
  swapAdminFunded: resolve(STATE_DIR, "swap-admin-funded.json"),
  /** Written by spec 03 (swap deploy): deployed contract addresses + password. */
  swapDeployment: resolve(STATE_DIR, "swap-deployment.json"),
  /** Written by spec 04 (fpc-signup): marker that both apps are signed up. */
  fpcSignedUp: resolve(STATE_DIR, "fpc-signedup.json"),
} as const;

/** Shape written by `global-setup` before any spec runs. */
export interface GlobalState {
  nodeUrl: string;
  l1RpcUrl: string;
  chainId: number;
  /** Deployed GoBridge contract address on L1. */
  l1BridgeAddress: string;
  /**
   * Swap-admin identity: secret + the salt it was derived with + the resulting L2 address. The
   * salt is forwarded to `deploy.ts` (spec 03) so the deployed-from address matches the one spec 02
   * bridge-funds — by construction, not by both happening to read an unset `SALT` env.
   */
  swapAdmin: { secret: string; salt: string; address: string };
}

/** Shape written after spec 01 finishes (fpc-dashboard setup). */
export interface FpcState {
  fpcAddress: string;
  fpcAdminAddress: string;
  fpcAdminSecretKey: string;
  fpcSecretKey: string;
  signedUp?: {
    [functionKey: string]: {
      contractAddress: string;
      functionName: string;
      selector: string;
      configIndex: number;
    };
  };
}

/** Shape written after spec 03 (swap deploy) finishes. */
export interface SwapDeploymentState {
  goCoin: string;
  goCoinPremium: string;
  liquidityToken: string;
  amm: string;
  pop: string;
  contractSalt: string;
  deployerAddress: string;
  rollupVersion: string;
  /**
   * Password baked into the PoP contract by `deploy.ts`. Generated fresh per
   * run (so there's no hardcoded secret) and read by downstream specs that
   * need to call `check_password_and_mint`.
   */
  password: string;
}

export async function writeState<T>(path: string, value: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf-8");
}

export async function readState<T>(path: string): Promise<T> {
  if (!existsSync(path)) throw new Error(`state file missing: ${path}`);
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

/** Returns true if a checkpoint already exists on disk. */
export function hasState(path: string): boolean {
  return existsSync(path);
}

/** Wipes the `.state/` dir. Called when E2E_RESET=1. */
export async function resetStateDir(): Promise<void> {
  await rm(STATE_DIR, { recursive: true, force: true });
  await mkdir(STATE_DIR, { recursive: true });
}

/**
 * Ensures `.state/` exists but leaves contents alone. Called by global-setup
 * on every run so incremental re-runs keep their checkpoints.
 */
export async function ensureStateDir(): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
}
