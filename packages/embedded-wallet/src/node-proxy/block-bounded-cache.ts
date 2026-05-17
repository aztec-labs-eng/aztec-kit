/**
 * Block-number-bounded cache for monotonic-in-upToBlockNumber responses.
 *
 * The Aztec node's `getPrivateLogsByTags(tags, page, referenceBlock)` filters
 * the returned logs by `upToBlockNumber = referenceBlock.number`. Importantly,
 * for a fixed tag and page, the response is **monotonic**: the response at a
 * higher block is a SUPERSET of the response at a lower block. PXE also
 * client-side filters logs by `blockNumber <= anchorBlockNumber` after the
 * call, so an over-shoot of in-cache logs is harmless — PXE drops the rest.
 *
 * This means: if we've cached a tag's response from scan at block `M`, we
 * can safely serve any query at anchor `≤ M` by filtering the cached entries
 * down to `blockNumber ≤ queryBlock`. We do NOT need a separate cache entry
 * per anchor.
 *
 * Why this matters: the previous anchor-keyed cache missed every time the
 * chain advanced between prefetch and PXE's sync (~every L2 block on an
 * active testnet). The block-bounded cache hits whenever `scannedAtBlock ≥
 * queryBlock`, which is the common case as long as the prefetcher has run
 * once recently at the current tip.
 *
 * Safety notes:
 *   1. The node returns logs in chronological order (ascending blockNumber)
 *      with a per-page limit (MAX_LOGS_PER_TAG = 10). A cached response from
 *      block M's page 0 contains the chronologically-first up-to-10 logs at
 *      blocks ≤ M. Filtering by `blockNumber ≤ X` where `X ≤ M` yields the
 *      chronologically-first up-to-10 logs at blocks ≤ X — exactly what the
 *      node would return for query at X.
 *   2. **Page 0 only.** Pages > 0 require knowing what the node skipped on
 *      lower pages; we can't reconstruct that from a single cached page.
 *      Page > 0 queries miss this cache and fall through.
 *   3. On reorg at block K, every cached entry with `scannedAtBlock > K`
 *      may contain logs that no longer exist on the canonical chain.
 *      `evictAbove(K)` removes them.
 *   4. Writes are monotonic: a later cache write at block M' replaces an
 *      earlier write at M only if M' > M.
 *
 * Generic over the value type V (logs array, leaf index, etc.). The filter
 * is supplied by the caller to drop entries with `blockNumber > queryBlock`.
 */
export class BlockBoundedCache<V> {
  readonly #entries = new Map<string, { value: V; scannedAtBlock: number }>();

  /**
   * Returns the cached value filtered down to `queryBlock`, or `undefined`
   * if the cache hasn't scanned high enough yet.
   *
   * `filter` produces a "subset" of the cached value valid for queryBlock.
   * For logs it drops entries with blockNumber > queryBlock. For a
   * single-value (leaf index), it returns undefined when the cached
   * inserted-at block > queryBlock.
   */
  get(key: string, queryBlock: number, filter: (v: V, queryBlock: number) => V): V | undefined {
    const e = this.#entries.get(key);
    if (!e) return undefined;
    if (e.scannedAtBlock < queryBlock) return undefined;
    return filter(e.value, queryBlock);
  }

  /**
   * Stores the value with a known scanned-at block. Newer scans replace
   * older. Older scans against the same key are dropped (we already have
   * better data).
   */
  set(key: string, value: V, scannedAtBlock: number): void {
    const existing = this.#entries.get(key);
    if (existing && existing.scannedAtBlock >= scannedAtBlock) return;
    this.#entries.set(key, { value, scannedAtBlock });
  }

  /**
   * Reorg invalidation. Drop any entry whose `scannedAtBlock` is at-or-above
   * the reorg point — the cached value may include logs from blocks that
   * no longer exist on the canonical chain.
   */
  evictAtOrAbove(blockNumber: number): number {
    let dropped = 0;
    for (const [k, e] of this.#entries) {
      if (e.scannedAtBlock >= blockNumber) {
        this.#entries.delete(k);
        dropped++;
      }
    }
    return dropped;
  }

  clear(): void {
    this.#entries.clear();
  }

  size(): number {
    return this.#entries.size;
  }

  /** Test inspection. */
  scannedAtBlockOf(key: string): number | undefined {
    return this.#entries.get(key)?.scannedAtBlock;
  }
}
