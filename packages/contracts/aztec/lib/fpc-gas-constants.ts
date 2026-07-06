/**
 * Gas constants for sponsored transactions.
 *
 * Operators compute sponsored gas limits as:
 *
 *   gasLimits      = calibrate.gasLimits + FPC_{SPONSOR,SUBSCRIBE}_OVERHEAD
 *   teardownLimits = 0
 *
 * The overhead depends on whether the sponsored function has an enqueued
 * public call:
 *
 *   - Sponsored function is private-only → use the `*_PRIVATE` overhead.
 *   - Sponsored function has a public call → use the `*_PUBLIC` overhead.
 *
 * `calibrateSponsoredApp` measures the sponsored function gas under the
 * exact same call path it'll take at runtime (top-of-stack FPC entrypoint,
 * `msg_sender == FPC`, with public-authwit consumption when applicable),
 * so `calibrate + FPC_*_OVERHEAD` lands on the exact runtime gas — pinned
 * by the invariant test in `fpc-overhead.test.ts`.
 *
 * The public/private overheads differ because when the sponsored function
 * enqueues a public call, the tx shifts into the public-pricing regime and
 * the FPC's own private side effects (note hashes + nullifiers from
 * `sponsor`/`subscribe` bookkeeping) get charged at AVM rates.
 *
 * Measurements live in `fpc-overhead.test.ts`, which pins these values
 * against a real deployment.
 */

/** Subscribe overhead on L2 gas when the sponsored fn is private-only */
export const FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE = 23400;

/** Subscribe overhead on DA gas when the sponsored fn is private-only */
export const FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE = 1152;

/** Subscribe overhead on L2 gas when the sponsored fn has a public call */
export const FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC = 43550;

/** Subscribe overhead on DA gas when the sponsored fn has a public call */
export const FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC = 1152;

/** Sponsor overhead on L2 gas when the sponsored fn is private-only */
export const FPC_SPONSOR_OVERHEAD_L2_GAS_PRIVATE = 11700;

/** Sponsor overhead on DA gas when the sponsored fn is private-only */
export const FPC_SPONSOR_OVERHEAD_DA_GAS_PRIVATE = 576;

/** Sponsor overhead on L2 gas when the sponsored fn has a public call */
export const FPC_SPONSOR_OVERHEAD_L2_GAS_PUBLIC = 21775;

/** Sponsor overhead on DA gas when the sponsored fn has a public call */
export const FPC_SPONSOR_OVERHEAD_DA_GAS_PUBLIC = 576;

/** FPC teardown L2 gas */
export const FPC_TEARDOWN_L2_GAS = 0;

/** FPC teardown DA gas */
export const FPC_TEARDOWN_DA_GAS = 0;
