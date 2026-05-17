/**
 * Collapse concurrent identical requests onto a single shared promise.
 *
 * Used at per-element granularity for decomposable methods (per-tag /
 * per-leaf) so that two overlapping `getPrivateLogsByTags` calls in
 * different batches don't fire duplicate upstream queries for shared tags.
 */
export class InflightDedup<K, V> {
  readonly #inflight = new Map<K, Promise<V>>();

  run(key: K, fn: () => Promise<V>): Promise<V> {
    const pending = this.#inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        return await fn();
      } finally {
        // Always release the slot, even on rejection — callers that
        // retried during the failure are now free to retry directly.
        this.#inflight.delete(key);
      }
    })();

    this.#inflight.set(key, p);
    return p;
  }

  size(): number {
    return this.#inflight.size;
  }
}
