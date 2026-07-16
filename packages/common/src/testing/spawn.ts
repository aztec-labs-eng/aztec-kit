/**
 * Shared spawn helpers for tests that bring up the full
 * `aztec start --local-network` stack. Two concerns are bundled here:
 *
 *   1. Killing the whole child process tree on shutdown.
 *      `aztec start --local-network` spawns its own helpers; a bare
 *      `child.kill()` on the parent does not propagate to those grandchildren,
 *      so orphans survive after the test runner exits. We work around that by
 *      spawning every child as its own process-group leader (`detached: true`)
 *      and killing with `process.kill(-pid, …)` so the entire group goes down.
 *
 *   2. Defensive cleanup if the test runner itself dies uncleanly (Ctrl+C,
 *      vitest crash, uncaught exception). We register `SIGINT`/`SIGTERM`/
 *      `SIGHUP`/`exit` handlers exactly once that nuke every tracked child
 *      before re-raising the signal.
 */

import { spawn, type ChildProcess } from "node:child_process";

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
