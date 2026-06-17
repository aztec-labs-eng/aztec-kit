import { CheatCodes } from "@aztec/aztec/testing";
import { type AztecNode, createAztecNodeClient } from "@aztec/aztec.js/node";
import { type AztecNodeDebug, createAztecNodeDebugClient } from "@aztec/stdlib/interfaces/client";
import { DateProvider } from "@aztec/foundation/timer";

/**
 * Starts a background loop that advances L1+L2 time + mines an L2 block
 * every `intervalMs`. Use this while the bridge app (or any other UI) is
 * waiting for an L1→L2 message to sync: local-network is idle unless we
 * push it.
 *
 * Usage:
 *   const stop = await pumpL2Blocks();
 *   try {
 *     await expect(...).toBeVisible(); // UI sees message ready
 *   } finally {
 *     await stop();              // guaranteed quiescent after this resolves
 *   }
 *
 * `stop()` is guaranteed to wait for the last in-flight warp to resolve
 * (or reject) before returning — so downstream code can rely on the node
 * being quiescent (no competing block production) as soon as `stop()`
 * resolves. Critical for specs that submit real txs right after pumping:
 * leaving a warp racing against a deploy causes the deploy to land mid-
 * slot and silently stall.
 */
const WARP_BY_SECONDS = 36n; // one L2 slot

export async function pumpL2Blocks(
  opts: { nodeUrl?: string; l1RpcUrl?: string; intervalMs?: number } = {},
): Promise<() => Promise<void>> {
  const nodeUrl = opts.nodeUrl ?? "http://localhost:8080";
  const l1RpcUrl = opts.l1RpcUrl ?? "http://localhost:8545";
  const intervalMs = opts.intervalMs ?? 2000;

  const node = createAztecNodeClient(nodeUrl);
  const nodeDebug = createAztecNodeDebugClient(nodeUrl);
  // v5's `warpL2TimeAtLeastBy` wants `AztecNode & AztecNodeDebug` (it reads
  // current L1 timestamp via the regular API before warping). Both clients
  // target the same URL and expose methods as own properties on the rpc
  // proxy, so a shallow merge is safe.
  const fullNode = Object.assign({}, node, nodeDebug) as AztecNode & AztecNodeDebug;
  const cheatCodes = await CheatCodes.create([l1RpcUrl], node, new DateProvider());

  const controller = new AbortController();
  const { signal } = controller;

  // An interruptible sleep tied to the controller's abort signal. As soon
  // as `controller.abort()` fires the pending timer rejects and we bail
  // out of the loop.
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });

  const loop = (async () => {
    while (!signal.aborted) {
      try {
        await cheatCodes.warpL2TimeAtLeastBy(fullNode, WARP_BY_SECONDS);
      } catch (err) {
        if (!signal.aborted) {
          console.warn(`[pump-l2-blocks] warp failed: ${(err as Error).message}`);
        }
      }
      if (signal.aborted) break;
      try {
        await sleep(intervalMs);
      } catch {
        break;
      }
    }
  })();

  return async () => {
    controller.abort();
    await loop;
  };
}
