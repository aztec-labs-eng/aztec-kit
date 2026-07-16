/**
 * Subprocess local-network fixture for the playwright e2e harness.
 *
 * Shells out to `aztec start --local-network`, which forks anvil + node +
 * sequencer + prover as one process tree on fixed ports (8545/8080). Slower
 * than running in-process, but exercises the same CLI users hit.
 *
 * For vitest suites that want a fast, parallel-safe, in-process network,
 * use `setupLocalNetwork` — as of v5.0.1 the framework we used to maintain
 * here ships upstream in `@aztec/aztec/testing`, re-exported by `./index.ts`.
 *
 * Process-group spawn and cleanup live in `./spawn.ts`, so killing the test
 * runner (cleanly or not) tears down every spawned child — no orphan anvils.
 */

import { type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killTracked, spawnTracked } from "./spawn.ts";

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
