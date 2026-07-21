/**
 * Client-side seat picking for the SubscriptionFPC's ticket-nullifier design.
 *
 * Each subscription "seat" is a slot `0 <= seat < max_users` for a config.
 * `subscribe` claims a seat by emitting a per-seat nullifier
 * (`poseidon2_hash_with_separator([config_id, seat], SEAT_NULLIFIER_SEPARATOR)`,
 * siloed by the FPC's address). The protocol rejects duplicate nullifiers, so
 * at most one subscriber can ever claim a given seat, and at most `max_users`
 * seats exist per config. There is no shared mutable on-chain state on the
 * signup path, so concurrent subscribers picking *distinct* seats never race.
 *
 * To subscribe, a client picks a seat that is not yet taken. "Taken" means the
 * seat's siloed nullifier already exists in the nullifier tree, which we probe
 * via `node.findLeavesIndexes` (the node stores siloed values). Picking
 * uniformly at random among the free seats is what makes concurrent
 * subscribers avoid each other. A same-block collision (two clients pick the
 * same free seat in the same block) still surfaces as a duplicate-nullifier tx
 * failure; the caller may retry with a fresh pick.
 */

import type { AztecNode } from "@aztec/aztec.js/node";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2HashWithSeparator } from "@aztec/foundation/crypto/poseidon";
import { siloNullifier } from "@aztec/stdlib/hash";
import { MerkleTreeId } from "@aztec/stdlib/trees";

/**
 * Domain separator for seat-ticket nullifiers. MUST mirror the
 * `SEAT_NULLIFIER_SEPARATOR` global in the Noir contract
 * (`noir/subscription-fpc/src/main.nr`) — the `computeSeatNullifier`↔
 * `compute_seat_nullifier` parity check in the tests pins this.
 */
export const SEAT_NULLIFIER_SEPARATOR = 1397047636;

/**
 * The node caps `findLeavesIndexes` at 100 leaves per call (verified
 * empirically — see `nullifier-scan-bench.ts`). Scans larger than this are
 * split into parallel chunks.
 */
const MAX_LEAVES_PER_CALL = 100;

/** How many random seats to probe before falling back to a full scan. */
const SAMPLE_SIZE = 100;

/**
 * Computes the INNER (unsiloed) seat-ticket nullifier for a `(configId, seat)`
 * pair, mirroring the Noir `compute_seat_nullifier_inner` library method. The
 * value stored in the nullifier tree is this siloed by the FPC's address (see
 * `siloNullifier`).
 */
export async function computeSeatNullifier(configId: Fr, seat: number): Promise<Fr> {
  return poseidon2HashWithSeparator([configId, new Fr(seat)], SEAT_NULLIFIER_SEPARATOR);
}

/**
 * Rejects a `maxUsers` that isn't a positive integer. This must be loud:
 * `undefined`/`NaN` slip past `<=` comparisons and, worse, make
 * `randomDistinctSeats` loop forever (`Math.random() * undefined` is `NaN`,
 * which a `Set` dedupes, so the sample never fills) — in a browser that
 * freezes the main thread with no error at all.
 */
function assertValidMaxUsers(maxUsers: number): void {
  if (!Number.isInteger(maxUsers) || maxUsers <= 0) {
    throw new Error(
      `maxUsers must be a positive integer, got ${maxUsers} — is the network config's subscriptionFPC entry missing the maxUsers field?`,
    );
  }
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Picks `count` distinct seats uniformly at random from `[0, maxUsers)`. */
function randomDistinctSeats(maxUsers: number, count: number): number[] {
  const picked = new Set<number>();
  while (picked.size < count) picked.add(Math.floor(Math.random() * maxUsers));
  return [...picked];
}

/** Computes the SILOED seat-ticket nullifiers (tree leaf values) for `seats`. */
async function siloedSeatNullifiers(
  fpcAddress: AztecAddress,
  configId: Fr,
  seats: number[],
): Promise<Fr[]> {
  return Promise.all(
    seats.map(async (seat) =>
      siloNullifier(fpcAddress, await computeSeatNullifier(configId, seat)),
    ),
  );
}

/**
 * Returns the subset of `seats` whose seat-ticket nullifier already exists on
 * chain. Batches into parallel chunks of {@link MAX_LEAVES_PER_CALL}.
 */
async function takenSeats(
  node: AztecNode,
  fpcAddress: AztecAddress,
  configId: Fr,
  seats: number[],
): Promise<number[]> {
  const chunks = chunk(seats, MAX_LEAVES_PER_CALL);
  const results = await Promise.all(
    chunks.map(async (seatChunk) => {
      const leaves = await siloedSeatNullifiers(fpcAddress, configId, seatChunk);
      const found = await node.findLeavesIndexes("latest", MerkleTreeId.NULLIFIER_TREE, leaves);
      return seatChunk.filter((_, i) => found[i] !== undefined);
    }),
  );
  return results.flat();
}

/** Picks a free seat uniformly at random from `candidates`, or `undefined`. */
function pickFree(candidates: number[], taken: number[]): number | undefined {
  const takenSet = new Set(taken);
  const free = candidates.filter((seat) => !takenSet.has(seat));
  if (free.length === 0) return undefined;
  return free[Math.floor(Math.random() * free.length)];
}

/**
 * Finds a free subscription seat for a config, picking uniformly at random
 * among the free seats so concurrent subscribers avoid each other.
 *
 * Strategy: for small configs (`maxUsers <= 100`) scan all seats in a single
 * node call. For large configs, probe a random sample of 100 seats first
 * (cheap, and near-certain to hit a free seat while capacity remains), and
 * only fall back to a full parallel scan if the whole sample is taken.
 *
 * Throws when every seat is taken.
 */
export async function findFreeSeat(params: {
  node: AztecNode;
  fpcAddress: AztecAddress;
  configId: Fr;
  maxUsers: number;
}): Promise<number> {
  const { node, fpcAddress, configId, maxUsers } = params;
  assertValidMaxUsers(maxUsers);

  const scanAll = async (): Promise<number> => {
    const all = range(maxUsers);
    const taken = await takenSeats(node, fpcAddress, configId, all);
    const seat = pickFree(all, taken);
    if (seat === undefined) {
      throw new Error(`all ${maxUsers} subscription seats for this config are taken`);
    }
    return seat;
  };

  if (maxUsers <= SAMPLE_SIZE) {
    return scanAll();
  }

  // Large config: try a random sample before committing to a full scan.
  const sample = randomDistinctSeats(maxUsers, SAMPLE_SIZE);
  const sampledTaken = await takenSeats(node, fpcAddress, configId, sample);
  const sampledSeat = pickFree(sample, sampledTaken);
  if (sampledSeat !== undefined) return sampledSeat;

  return scanAll();
}

/**
 * Counts how many subscription seats remain free for a config. Full scan.
 * Replaces the deleted `count_available_slots` contract utility.
 */
export async function countAvailableSeats(params: {
  node: AztecNode;
  fpcAddress: AztecAddress;
  configId: Fr;
  maxUsers: number;
}): Promise<number> {
  const { node, fpcAddress, configId, maxUsers } = params;
  assertValidMaxUsers(maxUsers);
  const taken = await takenSeats(node, fpcAddress, configId, range(maxUsers));
  return maxUsers - taken.length;
}
