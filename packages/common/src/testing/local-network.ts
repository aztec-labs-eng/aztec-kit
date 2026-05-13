/**
 * Local-network fixtures for tests.
 *
 * Two launch modes:
 *
 *   - {@link setupLocalNetwork} (in-process) — spawns anvil on a random
 *     port and runs the Aztec node inline as `AztecNodeService`. Genesis
 *     pre-fund support, parallel-safe, fast. Used by vitest suites.
 *
 *   - {@link setupLocalNetworkCli} (subprocess) — shells out to
 *     `aztec start --local-network`, which forks anvil + node + sequencer
 *     + prover as one process tree on fixed ports (8545/8080). Slower,
 *     but exercises the same CLI users hit. Used by the playwright e2e
 *     harness.
 *
 * Binary resolution and process-group cleanup are shared via `./spawn.ts`,
 * so killing the test runner (cleanly or not) tears down every spawned
 * child — no orphan anvils.
 *
 * We inline our own `startAnvil` because the copy in `@aztec/ethereum/test`
 * shells out to `scripts/anvil_kill_wrapper.sh`, which isn't shipped in
 * the published npm tarball.
 */

import { AztecNodeService } from "@aztec/aztec-node";
import { getConfigEnvVars as getAztecNodeConfigEnvVars } from "@aztec/aztec-node/config";
import type { AztecNodeConfig } from "@aztec/aztec-node/config";
import { Fr } from "@aztec/aztec.js/fields";
import { GENESIS_ARCHIVE_ROOT } from "@aztec/constants";
import { getL1ContractsConfigEnvVars } from "@aztec/ethereum/config";
import { deployAztecL1Contracts } from "@aztec/ethereum/deploy-aztec-l1-contracts";
import { EthCheatCodesWithState } from "@aztec/ethereum/test";
import { SecretValue } from "@aztec/foundation/config";
import { EthAddress } from "@aztec/foundation/eth-address";
import { TestDateProvider } from "@aztec/foundation/timer";
import { getVKTreeRoot } from "@aztec/noir-protocol-circuits-types/vk-tree";
import { protocolContractsHash } from "@aztec/protocol-contracts";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  initTelemetryClient,
  getConfigEnvVars as getTelemetryConfig,
} from "@aztec/telemetry-client";
import { getGenesisValues } from "@aztec/world-state/testing";
import { AnvilTestWatcher } from "@aztec/aztec/testing";
import { type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { foundry } from "viem/chains";
import { ensureAztecBinsInPath, killTracked, resolveAnvilBinary, spawnTracked } from "./spawn.ts";

const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";

// ─────────────────────────────────────────────────────────────────────
// In-process launch mode
// ─────────────────────────────────────────────────────────────────────

export interface LocalNetwork {
  /** Fully-synced Aztec node, ready to serve client requests. */
  node: AztecNodeService;
  /** RPC URL of the spawned anvil instance. */
  l1RpcUrl: string;
  /** Chain id used on L1 (foundry's default 31337). */
  l1ChainId: number;
  /** Stops every process started by the fixture: node, watcher, anvil. */
  stop: () => Promise<void>;
}

export interface LocalNetworkOptions {
  /**
   * Addresses that should hold fee juice at genesis. Saves each of these
   * the round-trip of bridging + claiming FJ before they can pay for gas.
   */
  fundedAddresses?: AztecAddress[];
  /** Override the default 1e18 FJ per funded address. */
  initialAccountFeeJuice?: Fr;
}

/**
 * Spin up an in-process local network with the given addresses pre-funded.
 * Each call spawns its own anvil on a random port, so suites can run in
 * parallel without fighting over 8545. Caller must `await result.stop()`
 * in its teardown.
 */
export async function setupLocalNetwork(opts: LocalNetworkOptions = {}): Promise<LocalNetwork> {
  // ── 0. PATH. `@aztec/ethereum` shells out to bare `forge` for L1 deploys;
  //    aztec-up no longer pollutes the user's interactive PATH, so we have
  //    to splice the internal-bin directory in ourselves.
  ensureAztecBinsInPath();

  // ── 1. Anvil. No --block-time: the setup automines for L1 deploy and
  //    then switches to interval mining at `ethereumSlotDuration`.
  const { rpcUrl, stop: stopAnvil } = await startAnvil();
  const l1ChainId = foundry.id;

  // ── 2. L1 publisher key (foundry default mnemonic) ─────────────────
  const hdAccount = mnemonicToAccount(DEFAULT_MNEMONIC);
  const privateKey: Hex = `0x${Buffer.from(hdAccount.getHdKey().privateKey!).toString("hex")}`;

  // ── 3. Base node config ────────────────────────────────────────────
  //    Aligned with the e2e reference: test-only flags, fixed coinbase,
  //    minTxsPerBlock=1 so account-deploy txs land reliably in block 1.
  const config: AztecNodeConfig = {
    ...getAztecNodeConfigEnvVars(),
    l1RpcUrls: [rpcUrl],
    l1ChainId,
    sequencerPublisherPrivateKeys: [new SecretValue<Hex>(privateKey)],
    validatorPrivateKeys: new SecretValue<Hex[]>([privateKey]),
    coinbase: EthAddress.fromString(privateKeyToAddress(privateKey)),
    realProofs: false,
    enforceTimeTable: false,
    enableDelayer: true,
    listenAddress: "127.0.0.1",
    minTxPoolAgeMs: 0,
    minTxsPerBlock: 1,
    aztecTargetCommitteeSize: 0,
  };

  // ── 4. Genesis ─────────────────────────────────────────────────────
  const fundedAddresses = opts.fundedAddresses ?? [];
  const { genesisArchiveRoot, prefilledPublicData, fundingNeeded } = await getGenesisValues(
    fundedAddresses,
    opts.initialAccountFeeJuice,
  );

  // ── 5. L1 deployment. Anvil is automining by default (no `--block-time`
  //    passed), which matches the reference setup where
  //    `automineL1Setup` is left undefined.
  const dateProvider = new TestDateProvider();

  const deployL1 = await deployAztecL1Contracts(rpcUrl, privateKey, l1ChainId, {
    ...getL1ContractsConfigEnvVars(),
    ...config,
    vkTreeRoot: getVKTreeRoot(),
    protocolContractsHash,
    genesisArchiveRoot: fundedAddresses.length ? genesisArchiveRoot : new Fr(GENESIS_ARCHIVE_ROOT),
    feeJuicePortalInitialBalance: fundingNeeded,
    realVerifier: false,
  });
  config.l1Contracts = deployL1.l1ContractAddresses;
  config.rollupVersion = deployL1.rollupVersion;

  // ── 6. Watcher ─────────────────────────────────────────────────────
  const watcher = new AnvilTestWatcher(
    new EthCheatCodesWithState([rpcUrl], dateProvider),
    deployL1.l1ContractAddresses.rollupAddress,
    deployL1.l1Client,
    dateProvider,
  );
  await watcher.start();

  // ── 7. Node ────────────────────────────────────────────────────────
  const telemetry = await initTelemetryClient(getTelemetryConfig());
  const node = await AztecNodeService.createAndSync(
    config,
    { telemetry, dateProvider },
    { prefilledPublicData },
  );

  const stop = async () => {
    await node.stop();
    await watcher.stop();
    await stopAnvil();
  };

  return { node, l1RpcUrl: rpcUrl, l1ChainId, stop };
}

/**
 * Picks a random OS-assigned port and spawns `anvil` directly (no shell
 * wrapper). Process-group spawn + cleanup live in `./spawn.ts`.
 */
async function startAnvil(opts: { l1BlockTime?: number } = {}): Promise<{
  rpcUrl: string;
  stop: () => Promise<void>;
}> {
  const port = await reservePort();
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--accounts",
    "20",
    "--gas-limit",
    "45000000",
    "--chain-id",
    "31337",
  ];
  if (opts.l1BlockTime !== undefined) {
    args.push("--block-time", String(opts.l1BlockTime));
  }

  const child = spawnTracked(resolveAnvilBinary(), args, {
    env: { ...process.env, RAYON_NUM_THREADS: "1" },
  });

  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const onStdout = (data: Buffer) => {
      if (data.toString().includes("Listening on")) {
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        child.removeListener("close", onClose);
        resolve();
      }
    };
    const onStderr = (data: Buffer) => {
      stderr += data.toString();
    };
    const onClose = (code: number | null) => {
      reject(new Error(`anvil exited with code ${code} before listening. stderr: ${stderr}`));
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("close", onClose);
  });

  child.stdout?.resume();
  child.stderr?.resume();

  return { rpcUrl: `http://127.0.0.1:${port}`, stop: () => killTracked(child) };
}

async function reservePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("could not reserve port"));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// CLI launch mode
// ─────────────────────────────────────────────────────────────────────

export interface LocalNetworkCli {
  /** Ephemeral working directory used by the CLI (`AZTEC_WORKDIR`). */
  workDir: string;
  /** Aztec node JSON-RPC URL (defaults to localhost:8080). */
  nodeUrl: string;
  /** L1 RPC URL (defaults to localhost:8545). */
  l1RpcUrl: string;
  /** Kills the whole process group and removes the work dir. */
  stop: () => Promise<void>;
}

export interface LocalNetworkCliOptions {
  /**
   * Directory to drain `aztec start`'s stdout/stderr to as `aztec.log`. If
   * omitted the log goes to the work dir, which gets cleaned up on stop —
   * pass a sticky location (e.g. `e2e/playwright-report/`) if you want CI
   * to upload the log on failure.
   */
  logDir?: string;
}

const CLI_DEFAULT_NODE_URL = "http://localhost:8080";
const CLI_DEFAULT_L1_RPC_URL = "http://localhost:8545";
const CLI_READINESS_TIMEOUT_MS = 180_000;

/**
 * Spawns `aztec start --local-network` and waits for both L1 and the
 * Aztec node to answer JSON-RPC calls before resolving.
 */
export async function setupLocalNetworkCli(
  opts: LocalNetworkCliOptions = {},
): Promise<LocalNetworkCli> {
  ensureAztecBinsInPath();
  const workDir = await mkdtemp(join(tmpdir(), "aztec-kit-cli-"));

  // The CLI internally forks anvil + node + sequencer + prover as grandchildren.
  // spawnTracked makes the whole subtree a single process group, so killing
  // the leader nukes everything — no orphan anvil after a run.
  const proc: ChildProcess = spawnTracked("aztec", ["start", "--local-network"], {
    cwd: workDir,
    env: { ...process.env, AZTEC_WORKDIR: workDir },
  });

  // Drain stdout/stderr to a file. Unconsumed pipes fill their OS buffer
  // (~64KB on Linux) and then BLOCK the child on its next write — the node
  // appears healthy on HTTP until its internal log flush backs up enough to
  // stall the event loop, at which point it stops serving requests and dies.
  // CI trips this easily (higher log volume, no interactive terminal).
  const logDir = opts.logDir ?? workDir;
  await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, "aztec.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  try {
    await Promise.all([
      waitForRpc(proc, CLI_DEFAULT_L1_RPC_URL, "L1 RPC", {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      waitForRpc(proc, CLI_DEFAULT_NODE_URL, "Aztec node", {
        jsonrpc: "2.0",
        id: 1,
        method: "node_getNodeInfo",
        params: [],
      }),
    ]);
  } catch (err) {
    await killTracked(proc);
    throw err;
  }

  return {
    workDir,
    nodeUrl: CLI_DEFAULT_NODE_URL,
    l1RpcUrl: CLI_DEFAULT_L1_RPC_URL,
    stop: async () => {
      await killTracked(proc);
      logStream.end();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

/**
 * Poll a JSON-RPC endpoint until it returns a successful result (not just
 * an HTTP response). A TCP-accept probe passes as soon as the port is
 * open, which on a slow CI runner can be minutes before the node is
 * actually ready to serve `sendTx` / `getNodeInfo`.
 */
async function waitForRpc(
  proc: ChildProcess,
  url: string,
  label: string,
  request: { jsonrpc: "2.0"; id: number; method: string; params: unknown[] },
): Promise<void> {
  const deadline = Date.now() + CLI_READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`local-network (cli) exited early with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: unknown; error?: unknown };
        if (body.result !== undefined) return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${label} did not become ready at ${url}`);
}
