/**
 * TwoTierCache unit tests.
 *
 * These are the safety primitives: the proxy trusts the cache to never
 * serve a value whose anchor hash doesn't match what the caller asked
 * for. Any failure here would let a stale post-reorg value escape into a
 * simulation. Tests are deliberately narrow.
 */

import { describe, expect, it } from "vitest";

import { TwoTierCache } from "../../src/node-proxy/cache";

describe("TwoTierCache", () => {
  it("returns undefined for unknown speculative keys", () => {
    const c = new TwoTierCache<string>();
    expect(c.getSpeculative("k1", "h1")).toBeUndefined();
  });

  it("returns the stored speculative value when anchor hash matches", () => {
    const c = new TwoTierCache<string>();
    c.setSpeculative("k1", "v1", 10, "h1");
    expect(c.getSpeculative("k1", "h1")).toBe("v1");
  });

  it("MUST evict on anchor-hash mismatch — never return the stale value", () => {
    // A reorg replaced block 10's hash but the sniffer hasn't told us yet.
    // The caller passes the new (correct) hash; the cache holds the old.
    // This is the catastrophic stale-cache scenario — the cache must miss.
    const c = new TwoTierCache<string>();
    c.setSpeculative("k1", "stale", 10, "old-hash");
    expect(c.getSpeculative("k1", "new-hash")).toBeUndefined();
    // The mismatched entry is also removed (eager eviction), so a later
    // request with the new hash that *would* repopulate doesn't first
    // see the stale one.
    expect(c.sizes().speculative).toBe(0);
  });

  it("permanent tier stores and retrieves", () => {
    const c = new TwoTierCache<number>();
    c.setPermanent("k1", 42);
    expect(c.getPermanent("k1")).toBe(42);
  });

  it("evictAtOrAbove drops speculative entries at or above the reorg point", () => {
    const c = new TwoTierCache<string>();
    c.setSpeculative("k8", "v8", 8, "h8");
    c.setSpeculative("k9", "v9", 9, "h9");
    c.setSpeculative("k10", "v10", 10, "h10");
    c.setSpeculative("k11", "v11", 11, "h11");

    const dropped = c.evictAtOrAbove(10);

    expect(dropped).toBe(2); // 10 and 11
    expect(c.getSpeculative("k8", "h8")).toBe("v8");
    expect(c.getSpeculative("k9", "h9")).toBe("v9");
    expect(c.getSpeculative("k10", "h10")).toBeUndefined();
    expect(c.getSpeculative("k11", "h11")).toBeUndefined();
  });

  it("evictAtOrAbove does NOT touch permanent entries", () => {
    // Permanent entries are below the proven horizon by construction; a
    // reorg can't reach them. Verifying invariant.
    const c = new TwoTierCache<string>();
    c.setPermanent("kperm", "v");
    c.setSpeculative("kspec", "v", 10, "h10");

    c.evictAtOrAbove(5);

    expect(c.getPermanent("kperm")).toBe("v");
    expect(c.getSpeculative("kspec", "h10")).toBeUndefined();
  });

  it("promoteAtOrBelow moves speculative ≤ provenAt to permanent", () => {
    const c = new TwoTierCache<string>();
    c.setSpeculative("k5", "v5", 5, "h5");
    c.setSpeculative("k8", "v8", 8, "h8");
    c.setSpeculative("k10", "v10", 10, "h10");

    const promoted = c.promoteAtOrBelow(8);

    expect(promoted).toBe(2);
    expect(c.getPermanent("k5")).toBe("v5");
    expect(c.getPermanent("k8")).toBe("v8");
    expect(c.getPermanent("k10")).toBeUndefined();
    // Promoted entries leave the speculative tier.
    expect(c.getSpeculative("k5", "h5")).toBeUndefined();
    expect(c.getSpeculative("k8", "h8")).toBeUndefined();
    // Above-proven stays speculative.
    expect(c.getSpeculative("k10", "h10")).toBe("v10");
  });

  it("promoted entries are no longer subject to anchor-hash validation", () => {
    // Permanent entries are below the proven horizon. The proven horizon
    // is L1-final-or-later; reorging across it is the catastrophic chain
    // failure case, far beyond what the cache models. We DO still apply
    // the per-hit ring check at the proxy layer (defense in depth), but
    // the cache itself doesn't.
    const c = new TwoTierCache<string>();
    c.setSpeculative("k5", "v5", 5, "h5");
    c.promoteAtOrBelow(5);
    // getPermanent takes no anchor — by design.
    expect(c.getPermanent("k5")).toBe("v5");
  });
});
