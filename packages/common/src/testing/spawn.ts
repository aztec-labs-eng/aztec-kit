/**
 * Shared spawn helpers for tests that bring up a local L1 (anvil) or the full
 * `aztec start --local-network` stack. Two concerns are bundled here:
 *
 *   1. Resolving the `anvil` binary. As of the aztec-up change that stopped
 *      polluting the user's PATH with foundry/nargo, plain `anvil` is no longer
 *      on PATH — only `aztec-anvil` (a symlink in `~/.aztec/current/bin/`) is
 *      exposed. The real binary lives at `~/.aztec/current/internal-bin/anvil`.
 *
 *   2. Killing the whole child process tree on shutdown. Both `anvil` and
 *      `aztec start --local-network` spawn their own helpers; a bare
 *      `child.kill()` on the parent does not propagate to those grandchildren,
 *      so orphans survive after the test runner exits. We work around that by
 *      spawning every child as its own process-group leader (`detached: true`)
 *      and killing with `process.kill(-pid, …)` so the entire group goes down.
 *
 *   3. Defensive cleanup if the test runner itself dies uncleanly (Ctrl+C,
 *      vitest crash, uncaught exception). We register `SIGINT`/`SIGTERM`/
 *      `SIGHUP`/`exit` handlers exactly once that nuke every tracked child
 *      before re-raising the signal.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const tracked = new Set<ChildProcess>();
let handlersInstalled = false;

function installHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  // Synchronous best-effort cleanup on normal exit. Async work isn't allowed
  // in `exit` handlers, so we send SIGKILL directly.
  process.on("exit", () => {
    for (const child of tracked) killGroupSync(child, "SIGKILL");
  });

  // On Ctrl+C / kill, nuke children synchronously then re-raise the signal so
  // the parent (test runner) exits with the conventional code. If we instead
  // called `process.exit`, vitest's own teardown wouldn't run.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      for (const child of tracked) killGroupSync(child, "SIGKILL");
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

function killGroupSync(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      // Negative PID → kill the entire process group. Requires the child to
      // have been spawned with `detached: true`.
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Mutates `process.env.PATH` to include the directories where `aztec-up`
 * installs foundry/nargo binaries. Idempotent.
 *
 * Necessary because `@aztec/ethereum`'s deploy helpers internally `spawn`
 * bare `forge` (and friends) — those inherit PATH from us, so the only
 * place we can fix it is up here. Since the aztec-up change that stopped
 * polluting the user's interactive PATH, `forge`/`cast`/`anvil`/`nargo`
 * are only reachable via `~/.aztec/current/internal-bin/`.
 */
export function ensureAztecBinsInPath(): void {
  const dirs = [
    join(homedir(), ".aztec", "current", "internal-bin"),
    join(homedir(), ".foundry", "bin"),
  ].filter((d) => existsSync(d));

  if (dirs.length === 0) return;

  const sep = process.platform === "win32" ? ";" : ":";
  const current = process.env.PATH ?? "";
  const parts = current.split(sep);
  const missing = dirs.filter((d) => !parts.includes(d));
  if (missing.length === 0) return;

  process.env.PATH = [...missing, ...parts].filter(Boolean).join(sep);
}

/**
 * Locate the `anvil` binary. Order:
 *   1. `$ANVIL_BIN` (explicit override, e.g. for CI with a pinned version).
 *   2. `~/.aztec/current/internal-bin/anvil` — where aztec-up installs it.
 *   3. `~/.aztec/current/bin/aztec-anvil` — the publicly-exposed symlink.
 *   4. `~/.foundry/bin/anvil` — standalone foundryup install.
 *   5. `which anvil` — anything else on PATH.
 *
 * Throws with a directive error message if none of the above work.
 */
export function resolveAnvilBinary(): string {
  const envBin = process.env.ANVIL_BIN;
  if (envBin && existsSync(envBin)) return envBin;

  const candidates = [
    join(homedir(), ".aztec", "current", "internal-bin", "anvil"),
    join(homedir(), ".aztec", "current", "bin", "aztec-anvil"),
    join(homedir(), ".foundry", "bin", "anvil"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  const which = spawnSync("sh", ["-c", "command -v anvil"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim();
  }

  throw new Error(
    "anvil binary not found. Tried $ANVIL_BIN, ~/.aztec/current/internal-bin/anvil, " +
      "~/.aztec/current/bin/aztec-anvil, ~/.foundry/bin/anvil, and $PATH. " +
      "Install via `aztec-up` or set ANVIL_BIN to a working binary.",
  );
}

export interface SpawnTrackedOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * Spawn a child process in its own POSIX process group and register it for
 * cleanup. Caller is responsible for awaiting {@link killTracked} during
 * teardown — but if they don't, the process-exit hooks installed here will
 * SIGKILL the group as a last resort.
 */
export function spawnTracked(
  command: string,
  args: readonly string[],
  options: SpawnTrackedOptions = {},
): ChildProcess {
  installHandlers();
  const child = spawn(command, args as string[], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: options.env,
    cwd: options.cwd,
  });
  tracked.add(child);
  child.once("exit", () => tracked.delete(child));
  return child;
}

/**
 * Graceful teardown: SIGTERM the process group, escalate to SIGKILL after 5s,
 * resolve once the parent's `close` event fires (i.e. the OS has reaped it).
 */
export function killTracked(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    tracked.delete(child);

    if (child.exitCode !== null || child.signalCode !== null) {
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve();
      return;
    }

    killGroupSync(child, "SIGTERM");
    const killTimer = setTimeout(() => killGroupSync(child, "SIGKILL"), 5000);
    killTimer.unref();

    child.once("close", () => {
      clearTimeout(killTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve();
    });
  });
}
