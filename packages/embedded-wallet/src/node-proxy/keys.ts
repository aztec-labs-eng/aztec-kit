/**
 * Stable string key builders. All inputs are stringified via their
 * canonical `.toString()` so structurally-equal inputs always produce the
 * same key. Prefixes namespace each method's key space so a tag string can
 * never collide with a leaf string at the cache map level.
 */
export const k = {
  privateLogByTag: (tag: string, page: number, anchor: string) => `plt|${tag}|${page}|${anchor}`,
  publicLogByTag: (contract: string, tag: string, page: number, anchor: string) =>
    `pulg|${contract}|${tag}|${page}|${anchor}`,
  leafIndex: (treeId: number, leaf: string, anchor: string) => `lf|${treeId}|${leaf}|${anchor}`,
  nullifierWitness: (nullifier: string, anchor: string) => `nw|${nullifier}|${anchor}`,
  lowNullifierWitness: (nullifier: string, anchor: string) => `lnw|${nullifier}|${anchor}`,
  noteHashWitness: (noteHash: string, anchor: string) => `nhw|${noteHash}|${anchor}`,
  publicDataWitness: (leafSlot: string, anchor: string) => `pdw|${leafSlot}|${anchor}`,
  publicStorage: (contract: string, slot: string, anchor: string) => `ps|${contract}|${slot}|${anchor}`,
  txReceipt: (txHash: string) => `tr|${txHash}`,
  txEffect: (txHash: string) => `te|${txHash}`,
  contract: (address: string) => `c|${address}`,
  contractClass: (id: string) => `cc|${id}`,
};

export function str(x: { toString(): string } | string | number | bigint): string {
  if (typeof x === 'string') return x;
  return String(x);
}
