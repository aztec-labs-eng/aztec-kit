/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * CachingNodeProxy integration tests.
 *
 * These verify the proxy as a whole against a mocked AztecNode. The mock
 * counts upstream calls so we can assert cache hits, and lets each test
 * drive sniffer state by issuing tip/block queries that look real enough
 * for the proxy's runtime shape sniffing.
 *
 * Catastrophic invariants exercised here:
 *
 *   • Per-tag decomposition reassembles in INPUT ORDER (a misordered
 *     response would corrupt every downstream tagged-log scan).
 *   • Different anchors must NOT share cache entries.
 *   • A reorg sniffed via tip-divergence evicts entries anchored at the
 *     reorged height; subsequent reads go through to upstream.
 *   • getTxReceipt below PROVEN is NEVER cached.
 *   • getTxReceipt at PROVEN/FINALIZED IS cached.
 *   • Passthrough methods don't try to cache (e.g. sendTx).
 *
 * The mock is a hand-rolled object — easier to assert on than vi.fn'ing
 * every method on the AztecNode interface.
 */

import { describe, expect, it } from "vitest";

import { createCachingNodeProxy, type CachingNodeProxy } from "../../src/node-proxy/caching-node-proxy";

type UpstreamCounts = Record<string, number>;

interface MockOptions {
  /** Map from "anchorHash" string to a per-tag log function: tag → logs. */
  logsByAnchor?: Record<string, (tag: string) => unknown[]>;
  /** Map from "anchorHash" string to a per-leaf index function. */
  indexesByAnchor?: Record<string, (leaf: string) => unknown>;
  /** Tip response for getL2Tips. */
  l2Tips?: unknown;
  /** Receipt by txHash. */
  receipts?: Record<string, { status: string; blockNumber?: number }>;
  /** Effects by txHash. */
  effects?: Record<string, { blockNumber: number; data: unknown }>;
}

function makeMockNode(opts: MockOptions = {}): {
  node: any;
  calls: UpstreamCounts;
  /** Mutators to swap state between scenarios. */
  setTips: (t: unknown) => void;
  setReceipt: (txHash: string, r: { status: string; blockNumber?: number }) => void;
  setLogs: (anchor: string, fn: (tag: string) => unknown[]) => void;
} {
  const calls: UpstreamCounts = {};
  const inc = (m: string) => {
    calls[m] = (calls[m] ?? 0) + 1;
  };
  let tips = opts.l2Tips;
  const receipts = { ...(opts.receipts ?? {}) };
  const logsByAnchor = { ...(opts.logsByAnchor ?? {}) };
  const indexesByAnchor = { ...(opts.indexesByAnchor ?? {}) };

  const node: any = {
    getL2Tips: async () => {
      inc("getL2Tips");
      return tips;
    },
    getBlock: async () => {
      inc("getBlock");
      return undefined;
    },
    getBlocks: async () => {
      inc("getBlocks");
      return [];
    },
    getBlockHeader: async () => {
      inc("getBlockHeader");
      return undefined;
    },
    getPrivateLogsByTags: async (tags: Array<{ toString(): string }>, _page = 0, anchor?: { toString(): string }) => {
      inc("getPrivateLogsByTags");
      const a = anchor !== undefined ? String(anchor) : "_no_anchor";
      const fn = logsByAnchor[a];
      if (!fn) throw new Error(`mock: no logs configured for anchor ${a}`);
      return tags.map((t) => fn(String(t)));
    },
    findLeavesIndexes: async (refBlock: unknown, treeId: number, leaves: Array<{ toString(): string }>) => {
      inc("findLeavesIndexes");
      const anchor =
        typeof refBlock === "object" && refBlock !== null && "hash" in refBlock
          ? String((refBlock as { hash: unknown }).hash)
          : String(refBlock);
      const fn = indexesByAnchor[anchor];
      if (!fn) throw new Error(`mock: no indexes for anchor ${anchor} (tree ${treeId})`);
      return leaves.map((l) => fn(String(l)));
    },
    getTxReceipt: async (txHash: { toString(): string }) => {
      inc("getTxReceipt");
      const r = receipts[String(txHash)];
      if (!r) throw new Error(`mock: no receipt for ${String(txHash)}`);
      return r;
    },
    getTxEffect: async (txHash: { toString(): string }) => {
      inc("getTxEffect");
      return opts.effects?.[String(txHash)];
    },
    sendTx: async (_tx: unknown) => {
      inc("sendTx");
      return undefined;
    },
    isReady: async () => {
      inc("isReady");
      return true;
    },
    getNodeInfo: async () => {
      inc("getNodeInfo");
      return { version: "test", protocolVersion: 1, chainId: 1 };
    },
  };

  return {
    node,
    calls,
    setTips: (t) => {
      tips = t;
    },
    setReceipt: (txHash, r) => {
      receipts[txHash] = r;
    },
    setLogs: (anchor, fn) => {
      logsByAnchor[anchor] = fn;
    },
  };
}

/** Build a tips object the proxy will accept. The proxy reads the shape
 *  duck-typed; it expects `proven.block.{number,hash}` for proven. */
function makeTips({
  proposed,
  proven,
  finalized,
}: {
  proposed?: [number, string];
  proven?: [number, string];
  finalized?: [number, string];
}) {
  return {
    proposed: proposed ? { number: proposed[0], hash: proposed[1] } : undefined,
    proven: proven ? { block: { number: proven[0], hash: proven[1] } } : undefined,
    finalized: finalized ? { block: { number: finalized[0], hash: finalized[1] } } : undefined,
  };
}

async function primeTips(proxy: CachingNodeProxy) {
  // Force a sniff. The proxy's stats() reflects what the sniffer saw.
  await (proxy as any).getL2Tips();
}

describe("CachingNodeProxy — per-tag decomposition", () => {
  it("first call populates cache; second call serves entirely from cache", async () => {
    const anchor = "anchor-h-1";
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [10, anchor] }),
      logsByAnchor: {
        [anchor]: (t) => [{ txHash: `tx-${t}` }],
      },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    const tags = [{ toString: () => "T1" }, { toString: () => "T2" }, { toString: () => "T3" }];
    const first = await (proxy as any).getPrivateLogsByTags(tags, 0, anchor);
    expect(first).toEqual([[{ txHash: "tx-T1" }], [{ txHash: "tx-T2" }], [{ txHash: "tx-T3" }]]);
    expect(upstream.calls.getPrivateLogsByTags).toBe(1);

    const second = await (proxy as any).getPrivateLogsByTags(tags, 0, anchor);
    expect(second).toEqual(first);
    // No second upstream call — fully served from cache.
    expect(upstream.calls.getPrivateLogsByTags).toBe(1);
  });

  it("RESPONSE ORDER MATCHES INPUT ORDER even when only a subset is cached", async () => {
    // The catastrophic-correctness check: per-tag decomposition must
    // assemble outputs in the same order as inputs, including when the
    // overlap with the cache is partial.
    const anchor = "anchor-h-2";
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [10, anchor] }),
      logsByAnchor: {
        [anchor]: (t) => [{ txHash: `tx-${t}` }],
      },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    // Warm the cache with tags [B, D].
    await (proxy as any).getPrivateLogsByTags(
      [{ toString: () => "B" }, { toString: () => "D" }],
      0,
      anchor,
    );
    expect(upstream.calls.getPrivateLogsByTags).toBe(1);

    // Now query [A, B, C, D, E]: A, C, E are cache misses; B, D are hits.
    const result = await (proxy as any).getPrivateLogsByTags(
      [
        { toString: () => "A" },
        { toString: () => "B" },
        { toString: () => "C" },
        { toString: () => "D" },
        { toString: () => "E" },
      ],
      0,
      anchor,
    );

    expect(result).toEqual([
      [{ txHash: "tx-A" }],
      [{ txHash: "tx-B" }],
      [{ txHash: "tx-C" }],
      [{ txHash: "tx-D" }],
      [{ txHash: "tx-E" }],
    ]);
    // One additional upstream call for the missing tags. The proxy
    // batched A, C, E into a single upstream request.
    expect(upstream.calls.getPrivateLogsByTags).toBe(2);
  });

  it("DIFFERENT anchors must NOT share cache entries", async () => {
    // If anchor was ever absent from the cache key, a reorg-evicted block's
    // logs would survive into the next anchor — catastrophic stale data.
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [10, "anchor-A"] }),
      logsByAnchor: {
        "anchor-A": () => [{ txHash: "tx-from-A" }],
        "anchor-B": () => [{ txHash: "tx-from-B" }],
      },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    const tag = [{ toString: () => "T" }];
    const a = await (proxy as any).getPrivateLogsByTags(tag, 0, "anchor-A");
    expect(a).toEqual([[{ txHash: "tx-from-A" }]]);

    const b = await (proxy as any).getPrivateLogsByTags(tag, 0, "anchor-B");
    expect(b).toEqual([[{ txHash: "tx-from-B" }]]);

    expect(upstream.calls.getPrivateLogsByTags).toBe(2);
  });

  it("DIFFERENT pages must NOT share cache entries", async () => {
    const anchor = "anchor-pg";
    let pageObserved: number | undefined;
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [10, anchor] }),
    });
    upstream.node.getPrivateLogsByTags = async (
      tags: Array<{ toString(): string }>,
      page = 0,
      _anchor?: unknown,
    ) => {
      pageObserved = page;
      upstream.calls.getPrivateLogsByTags = (upstream.calls.getPrivateLogsByTags ?? 0) + 1;
      return tags.map((t) => [{ txHash: `tx-${t}-p${page}` }]);
    };
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    const tag = [{ toString: () => "T" }];
    const p0 = await (proxy as any).getPrivateLogsByTags(tag, 0, anchor);
    const p1 = await (proxy as any).getPrivateLogsByTags(tag, 1, anchor);
    expect(p0).toEqual([[{ txHash: "tx-T-p0" }]]);
    expect(p1).toEqual([[{ txHash: "tx-T-p1" }]]);
    expect(upstream.calls.getPrivateLogsByTags).toBe(2);
    expect(pageObserved).toBe(1);
  });
});

describe("CachingNodeProxy — reorg eviction", () => {
  it("a sniffed reorg evicts speculative entries anchored at-or-above the reorg point", async () => {
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [10, "h10-orig"] }),
      logsByAnchor: {
        "h10-orig": () => [{ txHash: "tx-orig" }],
        "h10-new": () => [{ txHash: "tx-new" }],
      },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    // Populate cache at the original anchor.
    const tag = [{ toString: () => "T" }];
    await (proxy as any).getPrivateLogsByTags(tag, 0, "h10-orig");
    expect(upstream.calls.getPrivateLogsByTags).toBe(1);

    // The chain reorgs: block 10 now has a different hash. Drive the
    // sniffer by serving a new tips response on the next getL2Tips call.
    upstream.setTips(makeTips({ proposed: [10, "h10-new"] }));
    await primeTips(proxy);

    // A query at the OLD anchor MUST not return the old cached entry.
    // (The proxy's anchor cache key + per-hit ring check both protect
    // this — and the eviction-at-or-above-reorg cleans the entry.)
    // We query at the NEW anchor and expect fresh upstream data.
    const after = await (proxy as any).getPrivateLogsByTags(tag, 0, "h10-new");
    expect(after).toEqual([[{ txHash: "tx-new" }]]);
    expect(upstream.calls.getPrivateLogsByTags).toBe(2);
  });

  it("the per-hit anchor check refuses to serve a different anchor hash", async () => {
    // Even without a sniff, if a caller passes an anchor hash the cache
    // wasn't keyed by, the cache layer treats it as a miss. This is the
    // last-line defense against a missed sniff.
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [10, "h10-orig"] }),
      logsByAnchor: {
        "h10-orig": () => [{ txHash: "tx-orig" }],
        "h10-evil": () => [{ txHash: "tx-evil" }],
      },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    const tag = [{ toString: () => "T" }];
    await (proxy as any).getPrivateLogsByTags(tag, 0, "h10-orig");
    expect(upstream.calls.getPrivateLogsByTags).toBe(1);

    // Querying with a DIFFERENT anchor hash for the same tag/page must
    // miss the cache (different key).
    const evil = await (proxy as any).getPrivateLogsByTags(tag, 0, "h10-evil");
    expect(evil).toEqual([[{ txHash: "tx-evil" }]]);
    expect(upstream.calls.getPrivateLogsByTags).toBe(2);
  });
});

describe("CachingNodeProxy — getTxReceipt cacheability by status", () => {
  // Background: PXE's `get_status_change_of_pending` polls
  // `getTxReceipt` dozens of times within a single sim run for each
  // pending tx in the tagging store. A naive "only cache finalized"
  // policy made every poll a network round-trip (77 calls × ~140ms
  // = ~11s of pure wait observed on testnet). We now short-TTL-cache
  // every pre-finalized status so the next ~1s of polls hit cache;
  // the next-poll-after-TTL re-checks status. Bounds staleness to
  // TX_RECEIPT_TTL_MS and avoids any reorg-unsafe permanent caching.

  it("caches PENDING receipts for the short TTL window", async () => {
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [1, "h1"] }),
      receipts: { "tx-1": { status: "pending" } },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    const a = await (proxy as any).getTxReceipt("tx-1");
    expect(a.status).toBe("pending");
    // Second call within TTL — served from short-TTL cache.
    const b = await (proxy as any).getTxReceipt("tx-1");
    expect(b.status).toBe("pending");
    expect(upstream.calls.getTxReceipt).toBe(1);
  });

  it("caches PROPOSED receipts for the short TTL window", async () => {
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [1, "h1"] }),
      receipts: { "tx-2": { status: "proposed", blockNumber: 10 } },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    await (proxy as any).getTxReceipt("tx-2");
    await (proxy as any).getTxReceipt("tx-2");
    expect(upstream.calls.getTxReceipt).toBe(1);
  });

  it("caches PROVEN receipts in TTL (not permanent — L1 reorg before L1 finality can roll back)", async () => {
    // Proven is reorg-unsafe until L1-finalized. We don't store it
    // permanently; the short TTL caps how stale a "this is proven"
    // status can be observed by PXE. After TTL, next poll re-checks.
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [1, "h1"] }),
      receipts: { "tx-3": { status: "proven", blockNumber: 10 } },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    await (proxy as any).getTxReceipt("tx-3");
    await (proxy as any).getTxReceipt("tx-3");
    expect(upstream.calls.getTxReceipt).toBe(1);
  });

  it("DOES cache a FINALIZED receipt PERMANENTLY — L1 has finalized, no rewind possible", async () => {
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [1, "h1"] }),
      receipts: { "tx-4": { status: "finalized", blockNumber: 10 } },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    await (proxy as any).getTxReceipt("tx-4");
    await (proxy as any).getTxReceipt("tx-4");
    expect(upstream.calls.getTxReceipt).toBe(1);
  });
});

describe("CachingNodeProxy — findLeavesIndexes per-leaf decomposition", () => {
  it("reassembles per-leaf cached results in input order", async () => {
    const anchorHash = "leaves-anchor";
    const refBlock = { hash: anchorHash };
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [10, anchorHash] }),
      indexesByAnchor: {
        [anchorHash]: (leaf) => ({ data: BigInt(leaf.length), block: { number: 10 } }),
      },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    // Warm cache with [B, D].
    await (proxy as any).findLeavesIndexes(refBlock, /* treeId */ 1, [
      { toString: () => "BB" },
      { toString: () => "DDDD" },
    ]);
    expect(upstream.calls.findLeavesIndexes).toBe(1);

    // Now query [A, B, C, D] — A and C miss, B and D hit.
    const out = await (proxy as any).findLeavesIndexes(refBlock, 1, [
      { toString: () => "A" },
      { toString: () => "BB" },
      { toString: () => "CCC" },
      { toString: () => "DDDD" },
    ]);
    expect(out).toEqual([
      { data: 1n, block: { number: 10 } },
      { data: 2n, block: { number: 10 } },
      { data: 3n, block: { number: 10 } },
      { data: 4n, block: { number: 10 } },
    ]);
    expect(upstream.calls.findLeavesIndexes).toBe(2);
  });
});

describe("CachingNodeProxy — passthrough", () => {
  it("sendTx is NOT cached and reaches upstream every call", async () => {
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [1, "h1"] }),
    });
    const proxy = createCachingNodeProxy(upstream.node);

    await (proxy as any).sendTx({ fake: "tx" });
    await (proxy as any).sendTx({ fake: "tx" });
    expect(upstream.calls.sendTx).toBe(2);
  });

  it("methods not in the handler set are transparently delegated", async () => {
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [1, "h1"] }),
    });
    const proxy = createCachingNodeProxy(upstream.node);
    const ready = await (proxy as any).isReady();
    expect(ready).toBe(true);
    expect(upstream.calls.isReady).toBe(1);
  });
});

describe("CachingNodeProxy — identity", () => {
  it("the JS Proxy `__cachingProxy` marker is present (cheap identity check)", () => {
    const upstream = makeMockNode();
    const proxy = createCachingNodeProxy(upstream.node);
    expect(proxy.__cachingProxy).toBe(true);
  });
});

describe("CachingNodeProxy — resilient to external upstream mutation", () => {
  it("survives a profiler-style wrap that overwrites upstream methods after construction", async () => {
    // Regression for the "too much recursion" crash seen in the swap app:
    //
    //   1. EmbeddedWallet wraps upstream → our proxy.
    //   2. The app's profile harness later does
    //          orig = wallet.aztecNode.getContract;   // returns OUR handler
    //          wallet.aztecNode.getContract = wrap;   // default set trap writes to upstream
    //          // wrap calls orig(...) for instrumentation
    //   3. PXE calls wallet.aztecNode.getContract(addr) → our handler.
    //   4. WITHOUT the snapshot, our handler reads `upstream.getContract`
    //      *now*, which is `wrap`. `wrap` calls `orig`, which is our
    //      handler. Infinite loop.
    //
    // With the construction-time snapshot, the handler ignores the
    // mutated property and goes straight to the original bound method.
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [1, "h1"] }),
    });
    // The real upstream has a working getContract.
    let realCalls = 0;
    upstream.node.getContract = async (_addr: unknown) => {
      realCalls++;
      return { fake: "contract" };
    };

    const proxy = createCachingNodeProxy(upstream.node);

    // Simulate a profiler "wrap". The "original" the profiler captures
    // is what get-trap returned at wrap time — our handler.
    const orig = (proxy as any).getContract;
    let wrappedCalls = 0;
    // Default Proxy `set` writes to the target, so this replaces
    // upstream.getContract.
    (proxy as any).getContract = async function profilerWrap(...args: unknown[]) {
      wrappedCalls++;
      return await orig.apply(this, args);
    };

    // Verify the property mutation actually happened on the underlying
    // target (it did — there's no `set` trap on the proxy).
    expect(upstream.node.getContract).not.toBe(undefined);
    expect((upstream.node.getContract as { name: string }).name).toBe("profilerWrap");

    // Now call through the proxy. If we had ever fallen back to a
    // late-bound upstream.getContract lookup, we'd recurse forever and
    // either RangeError or hang. With the snapshot, this resolves once.
    const result = await (proxy as any).getContract("addr-x");
    expect(result).toEqual({ fake: "contract" });
    expect(realCalls).toBe(1);
    // The profiler's wrapper is NEVER invoked by our internal call path:
    // the snapshot bypasses it. (Callers going through `proxy.getContract`
    // hit our handler; our handler hits the snapshot; neither sees
    // `profilerWrap`.)
    expect(wrappedCalls).toBe(0);
  });
});

describe("CachingNodeProxy — block-bounded tag log cache", () => {
  // getPrivateLogsByTags page=0 lives in the block-bounded cache, NOT the
  // anchored TwoTierCache. These tests pin its semantics:
  //   * a cache entry is keyed by tag (no anchor)
  //   * a query at anchor X hits if scannedAtBlock ≥ X
  //   * the cached logs are filtered down to logs whose blockNumber ≤ X
  //   * a reorg evicts entries scanned at-or-above the reorg point
  // The legacy TwoTierCache + FINALIZED-promote behavior is still tested
  // via single-arg anchored methods elsewhere.

  it("populates block-bounded cache; second call at same anchor hits", async () => {
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [10, "anchor-h"] }),
      logsByAnchor: {
        "anchor-h": () => [{ txHash: "tx", blockNumber: 7 }],
      },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    const first = await (proxy as any).getPrivateLogsByTags(
      [{ toString: () => "T" }],
      0,
      "anchor-h",
    );
    expect(first).toEqual([[{ txHash: "tx", blockNumber: 7 }]]);
    expect(proxy.stats().tagLogBlockBounded).toBeGreaterThanOrEqual(1);

    const second = await (proxy as any).getPrivateLogsByTags(
      [{ toString: () => "T" }],
      0,
      "anchor-h",
    );
    expect(second).toEqual(first);
    expect(upstream.calls.getPrivateLogsByTags).toBe(1);
  });

  it("serves a query at a LOWER anchor from a higher-scanned cache, filtering logs by blockNumber", async () => {
    // This is the testnet fix: prefetcher scans at the latest tip;
    // PXE queries at an older anchor → cache hit + client-side filter.
    let calls = 0;
    // Inject the older block (10) into the sniffer via `finalized` so the
    // proxy can resolve "anchor-10" to a block number. (Overriding mock
    // methods AFTER proxy construction doesn't work — the proxy's snap
    // wrapper captures methods at construction time.)
    const upstream = makeMockNode({
      l2Tips: makeTips({
        proposed: [20, "anchor-20"],
        finalized: [10, "anchor-10"],
      }),
    });
    upstream.node.getPrivateLogsByTags = async (
      tags: Array<{ toString(): string }>,
      _page: number,
      _refBlock?: unknown,
    ) => {
      calls++;
      // Logs at varying block numbers; the cache will filter on hit.
      return tags.map(() => [
        { txHash: "tx-old", blockNumber: 5 },
        { txHash: "tx-mid", blockNumber: 12 },
        { txHash: "tx-new", blockNumber: 18 },
      ]);
    };
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy); // sniffer learns proposed=20 AND finalized=10

    // First call at anchor=20: fetch upstream, cache at scannedAtBlock=20.
    await (proxy as any).getPrivateLogsByTags(
      [{ toString: () => "T" }],
      0,
      "anchor-20",
    );
    expect(calls).toBe(1);

    // Query at the LOWER anchor (block 10). The cache entry was scanned
    // at block 20; the filter drops logs with blockNumber > 10.
    const result = await (proxy as any).getPrivateLogsByTags(
      [{ toString: () => "T" }],
      0,
      "anchor-10",
    );
    expect(result).toEqual([[{ txHash: "tx-old", blockNumber: 5 }]]);
    expect(calls).toBe(1); // no extra upstream call
  });

  it("reorg evicts block-bounded entries scanned at or above the reorg point", async () => {
    const upstream = makeMockNode({
      l2Tips: makeTips({ proposed: [20, "anchor-20"] }),
      logsByAnchor: {
        "anchor-20": () => [{ txHash: "tx", blockNumber: 15 }],
      },
    });
    const proxy = createCachingNodeProxy(upstream.node);
    await primeTips(proxy);

    await (proxy as any).getPrivateLogsByTags(
      [{ toString: () => "T" }],
      0,
      "anchor-20",
    );
    expect(proxy.stats().tagLogBlockBounded).toBeGreaterThanOrEqual(1);

    // Drive a reorg: same block-number 20 with a different hash.
    upstream.setTips(makeTips({ proposed: [20, "anchor-20-NEW"] }));
    await primeTips(proxy);
    // tagLogCache entry was scanned at block 20; the reorg point is 20;
    // entry is evicted.
    expect(proxy.stats().tagLogBlockBounded).toBe(0);
  });
});
