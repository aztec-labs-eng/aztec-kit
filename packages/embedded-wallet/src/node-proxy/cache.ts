export interface SpeculativeEntry<V> {
  value: V;
  anchorNumber: number;
  anchorHash: string;
}

/**
 * Two-tier in-memory cache.
 *
 * permanent: data anchored to a block at or below the latest observed proven
 *            tip. Never evicted (reorgs cannot cross the finalized/proven
 *            line in practice — see design doc §3).
 *
 * speculative: data anchored to a block above the proven horizon. Evicted on
 *              reorg of the anchored block, or promoted to permanent when
 *              the proven tip advances past the anchor.
 *
 * The cache holds raw values; cache-key construction and anchor-hash
 * validation live in the proxy.
 */
export class TwoTierCache<V> {
  readonly #permanent = new Map<string, V>();
  readonly #speculative = new Map<string, SpeculativeEntry<V>>();

  getPermanent(key: string): V | undefined {
    return this.#permanent.get(key);
  }

  setPermanent(key: string, value: V): void {
    this.#permanent.set(key, value);
  }

  /**
   * Looks up a speculative entry. Returns undefined if missing OR if the
   * stored anchor hash doesn't match the caller's expected anchor hash
   * (stale across a reorg the sniffer hasn't observed yet). A mismatched
   * entry is removed eagerly.
   */
  getSpeculative(key: string, expectedAnchorHash: string): V | undefined {
    const e = this.#speculative.get(key);
    if (!e) return undefined;
    if (e.anchorHash !== expectedAnchorHash) {
      this.#speculative.delete(key);
      return undefined;
    }
    return e.value;
  }

  setSpeculative(key: string, value: V, anchorNumber: number, anchorHash: string): void {
    this.#speculative.set(key, { value, anchorNumber, anchorHash });
  }

  /** Drop speculative entries whose anchor block is at or above the reorg point. */
  evictAtOrAbove(blockNumber: number): number {
    let dropped = 0;
    for (const [k, e] of this.#speculative) {
      if (e.anchorNumber >= blockNumber) {
        this.#speculative.delete(k);
        dropped++;
      }
    }
    return dropped;
  }

  /**
   * Move speculative entries with anchor block ≤ provenAt into permanent.
   * Permanent entries silently overwrite any existing key.
   */
  promoteAtOrBelow(provenAt: number): number {
    let promoted = 0;
    for (const [k, e] of this.#speculative) {
      if (e.anchorNumber <= provenAt) {
        this.#permanent.set(k, e.value);
        this.#speculative.delete(k);
        promoted++;
      }
    }
    return promoted;
  }

  /** Whole-cache wipe — used only on catastrophic failures. */
  clear(): void {
    this.#permanent.clear();
    this.#speculative.clear();
  }

  sizes(): { permanent: number; speculative: number } {
    return { permanent: this.#permanent.size, speculative: this.#speculative.size };
  }
}
