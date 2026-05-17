/**
 * ReorgSniffer unit tests.
 *
 * The sniffer drives cache invalidation. A missed reorg here is the
 * catastrophic case: the proxy would keep serving stale values until
 * either the per-hit anchor check rejects them (safety net) or the
 * upstream eventually surfaces the divergence.
 *
 * Tests prove the sniffer:
 *   - records pinned (N, hash) pairs
 *   - signals onReorg when a different hash is observed at a known N
 *   - signals onFinalizedAdvance monotonically
 *   - the isAnchorStillValid check returns the right tri-state
 */

import { describe, expect, it, vi } from "vitest";

import { ReorgSniffer } from "../../src/node-proxy/reorg-sniffer";

function makeSniffer() {
  const onReorg = vi.fn();
  const onFinalizedAdvance = vi.fn();
  const sniffer = new ReorgSniffer({ onReorg, onFinalizedAdvance });
  return { sniffer, onReorg, onFinalizedAdvance };
}

describe("ReorgSniffer", () => {
  it("records a fresh pinned block without firing onReorg", () => {
    const { sniffer, onReorg } = makeSniffer();
    const fresh = sniffer.notePinnedBlock(10, "h10");
    expect(fresh).toBe(false);
    expect(onReorg).not.toHaveBeenCalled();
  });

  it("MUST fire onReorg when a known block's hash changes", () => {
    const { sniffer, onReorg } = makeSniffer();
    sniffer.notePinnedBlock(10, "h10-orig");
    sniffer.notePinnedBlock(11, "h11-orig");
    sniffer.notePinnedBlock(12, "h12-orig");

    const reorged = sniffer.notePinnedBlock(11, "h11-reorged");

    expect(reorged).toBe(true);
    expect(onReorg).toHaveBeenCalledTimes(1);
    expect(onReorg).toHaveBeenCalledWith(11);
  });

  it("purges ring entries at-or-above the reorg point", () => {
    // After a reorg at 11, blocks 11 and 12 are gone from the old chain.
    // We may not know the new chain's hashes yet for those heights, but
    // we MUST forget the old ones — otherwise a subsequent block 11 query
    // would compare against the wrong stored hash and miss the reorg.
    const { sniffer } = makeSniffer();
    sniffer.notePinnedBlock(10, "h10");
    sniffer.notePinnedBlock(11, "h11-orig");
    sniffer.notePinnedBlock(12, "h12-orig");

    sniffer.notePinnedBlock(11, "h11-new");

    expect(sniffer.isAnchorStillValid(10, "h10")).toBe(true);
    expect(sniffer.isAnchorStillValid(11, "h11-orig")).toBe(false);
    expect(sniffer.isAnchorStillValid(11, "h11-new")).toBe(true);
    // Block 12's old hash is purged; the ring has nothing at 12 now.
    expect(sniffer.isAnchorStillValid(12, "h12-orig")).toBeUndefined();
  });

  it("re-observing the SAME hash at a known height is a no-op", () => {
    const { sniffer, onReorg } = makeSniffer();
    sniffer.notePinnedBlock(10, "h10");
    sniffer.notePinnedBlock(10, "h10");
    sniffer.notePinnedBlock(10, "h10");
    expect(onReorg).not.toHaveBeenCalled();
  });

  it("isAnchorStillValid returns undefined when the ring knows nothing", () => {
    // The proxy uses undefined as "I don't know" — the per-hit safety
    // check in the proxy treats this distinctly from false.
    const { sniffer } = makeSniffer();
    expect(sniffer.isAnchorStillValid(999, "h999")).toBeUndefined();
  });

  it("noteTips fires onFinalizedAdvance ONLY when the L1-finalized tip advances", () => {
    // Proven advance does NOT promote — proven blocks can be reorged by
    // L1 before L1 finality. Permanent-tier promotion is strictly
    // gated on the finalized tip.
    const { sniffer, onFinalizedAdvance } = makeSniffer();

    // Proven-only updates should not fire.
    sniffer.noteTips({ proven: { number: 5, hash: "p5" } });
    expect(onFinalizedAdvance).not.toHaveBeenCalled();

    sniffer.noteTips({ finalized: { number: 3, hash: "f3" } });
    expect(onFinalizedAdvance).toHaveBeenCalledWith(3);

    sniffer.noteTips({ finalized: { number: 5, hash: "f5" } });
    expect(onFinalizedAdvance).toHaveBeenCalledWith(5);
    expect(onFinalizedAdvance).toHaveBeenCalledTimes(2);
  });

  it("noteTips does NOT fire onFinalizedAdvance for stale finalized values", () => {
    // Promotion is monotonic. A node may serve a slightly behind tip
    // briefly during gossip catch-up — we must not interpret that as
    // demotion.
    const { sniffer, onFinalizedAdvance } = makeSniffer();
    sniffer.noteTips({ finalized: { number: 10, hash: "f10" } });
    sniffer.noteTips({ finalized: { number: 8, hash: "f8" } });
    expect(onFinalizedAdvance).toHaveBeenCalledTimes(1);
    expect(onFinalizedAdvance).toHaveBeenCalledWith(10);
  });

  it("tip updates feed the ring too — a proposed reorg fires onReorg", () => {
    const { sniffer, onReorg } = makeSniffer();
    sniffer.noteTips({ proposed: { number: 10, hash: "h10-orig" } });
    sniffer.noteTips({ proposed: { number: 10, hash: "h10-reorged" } });
    expect(onReorg).toHaveBeenCalledWith(10);
  });

  it("ring cap evicts the OLDEST entries first", () => {
    const { sniffer } = makeSniffer();
    // Build a sniffer with a tiny cap to make the test fast.
    const tiny = new ReorgSniffer(
      { onReorg: () => undefined, onFinalizedAdvance: () => undefined },
      { ringCap: 3 },
    );
    tiny.notePinnedBlock(1, "h1");
    tiny.notePinnedBlock(2, "h2");
    tiny.notePinnedBlock(3, "h3");
    tiny.notePinnedBlock(4, "h4");
    tiny.notePinnedBlock(5, "h5");

    expect(tiny.ringSize()).toBe(3);
    // Oldest evicted; newest kept.
    expect(tiny.isAnchorStillValid(1, "h1")).toBeUndefined();
    expect(tiny.isAnchorStillValid(2, "h2")).toBeUndefined();
    expect(tiny.isAnchorStillValid(3, "h3")).toBe(true);
    expect(tiny.isAnchorStillValid(5, "h5")).toBe(true);
    void sniffer;
  });
});
