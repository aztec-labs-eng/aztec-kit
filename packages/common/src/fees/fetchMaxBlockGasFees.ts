/**
 * Historical block-base-fee aggregator for networks without a clustec
 * indexer. Walks the last `blocks` block headers from the node and returns
 * the highest per-gas fees observed across the window.
 *
 * Why max instead of a percentile: the wallet at runtime commits
 * `predicted(Limit) × 1.5` as its `maxFeesPerGas`. The protocol's predicted
 * value tracks current activity, so a long-running app's worst-case
 * commit is bounded by the historical peak base fee × (predicted/base
 * ratio ≈ 1.15) × 1.5. Using the observed `max` here gives the FPC's
 * `max_fee` calibration a stable upper bound that survives quiet
 * periods, when a snapshot-based calibration would otherwise lock in a
 * floor value and reject any subsequent busy-slot tx.
 *
 * Cheap: the node caps `getBlocks` at 50 per call, so 1000 blocks = 20
 * RPC round-trips. Headers only, no tx bodies.
 */

import type { AztecNode } from "@aztec/aztec.js/node";
import { BlockNumber } from "@aztec/foundation/branded-types";

export interface PeakGasFees {
  feePerDaGas: bigint;
  feePerL2Gas: bigint;
  /** Block range actually walked (clamped to chain tip). */
  fromBlock: number;
  toBlock: number;
  /** Number of blocks read. */
  sampleSize: number;
}

const NODE_GET_BLOCKS_LIMIT = 50;

export async function fetchMaxBlockGasFees(node: AztecNode, blocks: number): Promise<PeakGasFees> {
  const tip = await node.getBlockNumber();
  const fromBlock = Math.max(1, tip - blocks + 1);
  const toBlock = tip;

  let maxDa = 0n;
  let maxL2 = 0n;
  let sampleSize = 0;

  for (let start = fromBlock; start <= toBlock; start += NODE_GET_BLOCKS_LIMIT) {
    const limit = Math.min(NODE_GET_BLOCKS_LIMIT, toBlock - start + 1);
    const batch = await node.getBlocks(BlockNumber(start), limit);
    for (const block of batch) {
      const fees = block.header.globalVariables.gasFees;
      if (fees.feePerDaGas > maxDa) maxDa = fees.feePerDaGas;
      if (fees.feePerL2Gas > maxL2) maxL2 = fees.feePerL2Gas;
      sampleSize += 1;
    }
  }

  return { feePerDaGas: maxDa, feePerL2Gas: maxL2, fromBlock, toBlock, sampleSize };
}
