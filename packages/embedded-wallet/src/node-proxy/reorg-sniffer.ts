export type TipObservation = {
  proposed?: { number: number; hash: string };
  proven?: { number: number; hash: string };
  finalized?: { number: number; hash: string };
};

export interface SnifferHandlers {
  /** Reorg detected: every cached entry anchored at a block ≥ blockNumber must go. */
  onReorg(blockNumber: number): void;
  /**
   * L1-finalized tip advanced: entries with anchor ≤ finalizedAt can be
   * promoted to the permanent cache tier. Proven (but not yet finalized)
   * blocks are NOT safe — an L1 reorg before L1 finality can roll them
   * back, taking proofs and their L2 blocks with them.
   */
  onFinalizedAdvance(finalizedAt: number): void;
  /**
   * Proposed tip advanced (new L2 block observed). Caller may want to
   * re-warm prefetch caches at the new anchor — PXE's next entry-point
   * call will use the new anchor for its in-line queries, so cached
   * entries at the previous anchor become useless. Optional.
   */
  onProposedAdvance?(proposedAt: number, proposedHash: string): void;
}

/**
 * Passive observer of (blockNumber → blockHash) pairs and chain tips.
 *
 * Detects reorgs by hash divergence at a known height. The sniffer is fed
 * by the proxy's interception of node responses (getL2Tips / getChainTips /
 * getBlock / getBlocks / getBlockHeader). It does not poll.
 *
 * Invariants:
 *   - notePinnedBlock(N, H) updates the ring. If a *different* hash was
 *     previously recorded at N, that's a reorg: drop every ring entry at
 *     M ≥ N, then store (N, H), then signal onReorg(N).
 *   - noteTips() advances each tip monotonically. A proven tip that
 *     decreases is treated as informational noise (we don't go backwards
 *     in permanent-promotion).
 *
 * isAnchorStillValid is the per-cache-hit safety net: even if the sniffer
 * missed a reorg, a cached entry whose stored anchorHash doesn't match
 * what the ring currently holds at that height won't be served.
 */
export class ReorgSniffer {
  readonly #ring = new Map<number, string>();
  readonly #handlers: SnifferHandlers;
  #tipProposed?: { number: number; hash: string };
  #tipProven?: { number: number; hash: string };
  #tipFinalized?: { number: number; hash: string };
  /** Cap on ring entries kept; the oldest below this drift out. */
  readonly #ringCap: number;

  constructor(handlers: SnifferHandlers, opts: { ringCap?: number } = {}) {
    this.#handlers = handlers;
    this.#ringCap = opts.ringCap ?? 1024;
  }

  /**
   * Record an observation of (blockNumber, blockHash). Returns true if this
   * observation revealed a reorg.
   */
  notePinnedBlock(blockNumber: number, blockHash: string): boolean {
    const existing = this.#ring.get(blockNumber);
    if (existing !== undefined && existing !== blockHash) {
      // Reorg: the old chain we had recorded at this height is gone. Every
      // ring entry at M ≥ blockNumber may belong to the old chain — purge.
      for (const n of [...this.#ring.keys()]) {
        if (n >= blockNumber) this.#ring.delete(n);
      }
      this.#ring.set(blockNumber, blockHash);
      this.#enforceRingCap();
      this.#handlers.onReorg(blockNumber);
      return true;
    }
    this.#ring.set(blockNumber, blockHash);
    this.#enforceRingCap();
    return false;
  }

  noteTips(tips: TipObservation): void {
    if (tips.proposed) {
      const advanced =
        this.#tipProposed === undefined || tips.proposed.number > this.#tipProposed.number;
      const sameNumberDifferentHash =
        this.#tipProposed?.number === tips.proposed.number &&
        this.#tipProposed.hash !== tips.proposed.hash;
      if (advanced || sameNumberDifferentHash) {
        // notePinnedBlock handles both the fresh-advance case and the
        // same-height-different-hash (head reorg) case via its standard
        // divergence check.
        this.notePinnedBlock(tips.proposed.number, tips.proposed.hash);
        this.#tipProposed = tips.proposed;
        if (advanced) {
          // Fire the proposed-advance hook so caller (proxy) can re-warm
          // prefetch caches at the new anchor. Skip for the head-reorg
          // case (notePinnedBlock already evicted; promotion-style work
          // doesn't apply).
          this.#handlers.onProposedAdvance?.(tips.proposed.number, tips.proposed.hash);
        }
      }
    }
    if (tips.proven) {
      if (this.#tipProven === undefined || tips.proven.number > this.#tipProven.number) {
        this.#tipProven = tips.proven;
        this.notePinnedBlock(tips.proven.number, tips.proven.hash);
        // No promotion event for proven — proven blocks can still be
        // reorged by an L1 reorg before L1 finality. Promotion fires
        // strictly on finalized advance.
      }
    }
    if (tips.finalized) {
      if (this.#tipFinalized === undefined || tips.finalized.number > this.#tipFinalized.number) {
        this.#tipFinalized = tips.finalized;
        this.notePinnedBlock(tips.finalized.number, tips.finalized.hash);
        this.#handlers.onFinalizedAdvance(tips.finalized.number);
      }
    }
  }

  /**
   * Per-hit anchor validation. The caller is the proxy holding a cache
   * entry whose stored (blockNumber, anchorHash) we check against the ring.
   *
   * Returns:
   *   true       — ring agrees, entry is safe to serve.
   *   false      — ring disagrees: a reorg happened we may not have surfaced yet. Treat as miss.
   *   undefined  — ring has no opinion at this height. Up to the caller; we err toward "serve"
   *                only if the entry is in the permanent tier; speculative entries should fall
   *                through to upstream when the ring is silent. (The proxy enforces this.)
   */
  isAnchorStillValid(blockNumber: number, anchorHash: string): boolean | undefined {
    const ringHash = this.#ring.get(blockNumber);
    if (ringHash === undefined) return undefined;
    return ringHash === anchorHash;
  }

  latestProvenAt(): number | undefined {
    return this.#tipProven?.number;
  }

  /**
   * Most recently observed L1-finalized block number. This is the only tip
   * safe to use as a "permanent cache promotion" threshold — proven blocks
   * can still be reorged.
   */
  latestFinalizedAt(): number | undefined {
    return this.#tipFinalized?.number;
  }

  latestProposed(): { number: number; hash: string } | undefined {
    return this.#tipProposed;
  }

  ringSize(): number {
    return this.#ring.size;
  }

  ringEntries(): Array<[number, string]> {
    return Array.from(this.#ring.entries()).sort((a, b) => a[0] - b[0]);
  }

  #enforceRingCap(): void {
    if (this.#ring.size <= this.#ringCap) return;
    // Drop oldest blocks first (lowest numbers).
    const nums = Array.from(this.#ring.keys()).sort((a, b) => a - b);
    const dropCount = this.#ring.size - this.#ringCap;
    for (let i = 0; i < dropCount; i++) this.#ring.delete(nums[i]!);
  }
}
