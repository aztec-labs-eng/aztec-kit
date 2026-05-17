import type { AztecNode } from "@aztec/aztec.js/node";

import { BlockBoundedCache } from "./block-bounded-cache";
import { TwoTierCache } from "./cache";
import { InflightDedup } from "./inflight";
import { k, str } from "./keys";
import { ReorgSniffer, type TipObservation } from "./reorg-sniffer";

/**
 * Transparent caching proxy that sits between PXE and the upstream
 * `AztecNode`. Pure passive cache — there is no prefetcher and no
 * "anticipate what PXE will need" logic. We tried that; it didn't work
 * because PXE's tag scans are demand-driven from inside contract
 * execution (see `pxe/.../utility_execution_oracle.js`'s
 * `getPendingTaggedLogsV2` path) and there is no public sync API on PXE
 * to warm its internal stores from outside.
 *
 * What this proxy CAN do:
 *
 *   • Cache witness/state reads keyed by `(method, args, blockHash)`. If
 *     `simulateTx` and `proveTx` happen to query the same `(blockHash,
 *     leaf)` pair, the second hits the cache. Cross-anchor hits don't
 *     happen for these methods because the tree paths change per block.
 *
 *   • Cache `getPrivateLogsByTags` (page 0) and `findLeavesIndexes` with
 *     a BLOCK-BOUNDED key — store `{value, scannedAtBlock}`; serve any
 *     query at anchor ≤ scannedAtBlock by filtering. This is the only
 *     class of node call where a cache entry survives an L2 tip advance.
 *
 *   • Treat anything ≤ the L1-finalized tip as permanent; promote on
 *     `onFinalizedAdvance`. Proven-but-not-finalized stays speculative —
 *     a pre-finality L1 reorg can roll a proven L2 block back.
 *
 *   • Detect reorgs by hash divergence at known heights (the sniffer),
 *     and evict every cache entry whose anchor block is at-or-above the
 *     reorg point.
 *
 * What this proxy will NOT do:
 *
 *   • Reach into the wallet to learn about senders/recipients/contracts.
 *     The earlier design built up a "hint set" and used it to drive a
 *     prefetcher. PXE's tag scan is demand-driven and the prefetcher's
 *     RPCs landed AFTER the calls they were meant to satisfy — the whole
 *     concept was structurally wrong. We rip it out rather than carry
 *     the complexity for no payoff.
 *
 *   • Track upstream-call inflight count externally. The InflightDedup
 *     here is purely about collapsing concurrent identical RPCs onto a
 *     shared promise. No external lock.
 */
type Anchor = { number: number; hash: string };

export type CachingNodeProxy = AztecNode & {
  readonly __cachingProxy: true;
  /** Snapshot of cache sizes + per-method counters. */
  readonly stats: () => CacheStats;
};

export interface CachingNodeProxyOptions {
  /** Capacity of the reorg sniffer's (blockNumber → hash) ring. Defaults to 1024. */
  ringCap?: number;
}

export interface CacheStats {
  permanent: number;
  speculative: number;
  /** Block-bounded entries for getPrivateLogsByTags (page 0). */
  tagLogBlockBounded: number;
  /** Block-bounded entries for findLeavesIndexes. */
  leafIndexBlockBounded: number;
  ringSize: number;
  /** L2-proven tip (informational; not used for promotion). */
  provenAt?: number;
  /** L1-finalized tip (drives promotion to permanent). */
  finalizedAt?: number;
  proposed?: { number: number; hash: string };
  methods: Record<string, MethodCounters>;
}

export interface MethodCounters {
  /** Total times this method was called through the proxy. */
  calls: number;
  /** Cache hits — served from permanent or speculative without upstream. */
  hits: number;
  /** Cache misses — fell through to upstream. */
  misses: number;
  /** Upstream calls actually made (may be fewer than misses if dedup'd). */
  upstream: number;
  /** For decomposed methods: per-element seen / hit counts. */
  elements?: { seen: number; hits: number };
  /**
   * Calls originated by the wallet's tag warm-up rather than PXE. Warm
   * calls necessarily start as misses (they're populating the cache),
   * so they drag down the overall hit-rate metric. Subtracting them
   * gives a true PXE-side hit rate — the one that determines sim
   * latency.
   */
  warmCalls?: number;
  /** Hits attributable to warm-originated calls (a re-fetch of an already-cached tag). */
  warmHits?: number;
  /** Misses attributable to warm-originated calls. */
  warmMisses?: number;
}

/**
 * Construct a caching proxy around an upstream `AztecNode`. The returned
 * value is an `AztecNode` at the type level — PXE consumes it
 * transparently. No RPC happens at construction time; the cache
 * populates lazily as PXE issues calls.
 */
export function createCachingNodeProxy(
  upstream: AztecNode,
  options: CachingNodeProxyOptions = {},
): CachingNodeProxy {
  const cache = new TwoTierCache<unknown>();
  const tagLogCache = new BlockBoundedCache<unknown[]>();
  const leafIndexCache = new BlockBoundedCache<unknown>();
  const inflight = new InflightDedup<string, unknown>();

  const sniffer = new ReorgSniffer(
    {
      onReorg(blockNumber: number) {
        cache.evictAtOrAbove(blockNumber);
        tagLogCache.evictAtOrAbove(blockNumber);
        leafIndexCache.evictAtOrAbove(blockNumber);
      },
      onFinalizedAdvance(finalizedAt: number) {
        // Only L1-finalized blocks are safe for permanent promotion.
        // A proven-but-not-yet-finalized L2 block can be undone by an L1
        // reorg before L1 finality. We pay a longer wait in exchange for
        // the safety of never having a permanent entry survive a rewind.
        cache.promoteAtOrBelow(finalizedAt);
      },
    },
    { ringCap: options.ringCap },
  );

  // Per-method counters. Lazy-initialized.
  const counters: Record<string, MethodCounters> = {};

  /**
   * Short-TTL caches for `getTxReceipt` / `getTxEffect` / `getPublicStorageAt`
   * on data that isn't safe to cache permanently. PXE's
   * `get_status_change_of_pending` polls these hashes repeatedly inside
   * the simulator (77 receipt + 56 effect calls observed during one
   * testnet swap — ~20s of pure network time).
   *
   * Each method has its own TTL tuned to the kind of staleness that
   * can hurt:
   *
   *   • `getTxReceipt` (5s): status changes propagate within 5s of the
   *     window. PXE notices `pending → proven → finalized` transitions
   *     at most 5s late.
   *   • `getTxEffect` (60s): once a tx is in a block, its effect is
   *     fixed until reorg. 60s window collapses essentially all polls
   *     within a single sim+prove run; reorg-eviction handles the
   *     pre-finality unsafety.
   *   • `getPublicStorageAt` (1s): public storage CAN change per block.
   *     Bound stale reads to 1s; collapses bursts of reads within the
   *     same sim phase that miss our anchor-keyed cache because PXE
   *     uses a slightly different anchor than what's in the sniffer.
   *
   * Once a receipt's status hits `finalized` (L1-finalized), it
   * transitions to the permanent cache and bypasses this short TTL.
   * That's the only status we know is reorg-safe per L1 finality.
   */
  // TTLs tuned against live testnet swap traces:
  //   - 5s caught 30% of receipt polls; many are spread > 5s apart.
  //   - 60s on effect data is fine — content is immutable per block.
  //   - L2 block time on testnet is ~36s, so a 30s receipt TTL keeps
  //     status no more than one L2 block stale, which the UI won't
  //     notice during a single swap flow.
  const TX_RECEIPT_TTL_MS = 30_000;
  const TX_EFFECT_TTL_MS = 120_000;
  const PUBLIC_STORAGE_TTL_MS = 2000;
  type TtlEntry<V> = { value: V; expiresAt: number };
  const txReceiptTtlCache = new Map<string, TtlEntry<unknown>>();
  const txEffectTtlCache = new Map<string, TtlEntry<unknown>>();
  const publicStorageTtlCache = new Map<string, TtlEntry<unknown>>();
  function ttlGet<V>(m: Map<string, TtlEntry<unknown>>, key: string): V | undefined {
    const e = m.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= Date.now()) {
      m.delete(key);
      return undefined;
    }
    return e.value as V;
  }
  function ttlSet<V>(
    m: Map<string, TtlEntry<unknown>>,
    key: string,
    value: V,
    ttlMs: number,
  ): void {
    m.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  function counter(name: string): MethodCounters {
    let c = counters[name];
    if (!c) {
      c = { calls: 0, hits: 0, misses: 0, upstream: 0 };
      counters[name] = c;
    }
    return c;
  }

  /**
   * Flag set by the warm-up immediately before each `getPrivateLogsByTags`
   * call and consumed synchronously by the handler. Lets us attribute
   * calls to "warm vs PXE" so the hit-rate metric isn't polluted by the
   * warm's necessary populate-misses. JS event-loop guarantees: the
   * warmer calls `__markNextAsWarm()` then immediately `proxy.getX()`,
   * the handler reads the flag in its synchronous prelude before any
   * await — no race even under Promise.all fanout because each .map
   * callback runs sync up to the handler's first await.
   */
  let nextCallIsWarm = false;
  function consumeWarmFlag(): boolean {
    const v = nextCallIsWarm;
    nextCallIsWarm = false;
    return v;
  }
  function bumpWarmStats(c: MethodCounters, isWarm: boolean, kind: "hit" | "miss"): void {
    if (!isWarm) return;
    c.warmCalls = (c.warmCalls ?? 0) + 1;
    if (kind === "hit") c.warmHits = (c.warmHits ?? 0) + 1;
    else c.warmMisses = (c.warmMisses ?? 0) + 1;
  }
  function elementCounter(name: string): { seen: number; hits: number } {
    const c = counter(name);
    if (!c.elements) c.elements = { seen: 0, hits: 0 };
    return c.elements;
  }

  // Snapshot every upstream method we delegate to AT CONSTRUCTION TIME and
  // bind it to upstream. This shields us from external instrumentation that
  // mutates upstream method properties later (a profile harness re-assigning
  // `wallet.aztecNode.getContract`, for example). Without this snapshot, a
  // wrapper whose "original" reference is our proxy handler would re-enter
  // the handler, which would call the upstream method (now the wrapper),
  // and loop forever.
  type Method = (...args: unknown[]) => Promise<unknown>;
  const snap = (name: string): Method => {
    const fn = (upstream as unknown as Record<string, unknown>)[name];
    if (typeof fn !== "function") {
      return async () => {
        throw new Error(`CachingNodeProxy: upstream.${name} is not a function`);
      };
    }
    return (fn as (...a: unknown[]) => Promise<unknown>).bind(upstream) as Method;
  };
  const u = {
    getPrivateLogsByTags: snap("getPrivateLogsByTags"),
    getPublicLogsByTagsFromContract: snap("getPublicLogsByTagsFromContract"),
    findLeavesIndexes: snap("findLeavesIndexes"),
    getNullifierMembershipWitness: snap("getNullifierMembershipWitness"),
    getLowNullifierMembershipWitness: snap("getLowNullifierMembershipWitness"),
    getNoteHashMembershipWitness: snap("getNoteHashMembershipWitness"),
    getPublicDataWitness: snap("getPublicDataWitness"),
    getPublicStorageAt: snap("getPublicStorageAt"),
    getTxReceipt: snap("getTxReceipt"),
    getTxEffect: snap("getTxEffect"),
    getContract: snap("getContract"),
    getContractClass: snap("getContractClass"),
    getL2Tips: snap("getL2Tips"),
    getBlock: snap("getBlock"),
    getBlocks: snap("getBlocks"),
    getBlockHeader: snap("getBlockHeader"),
  };

  // ---- Anchor utilities ----------------------------------------------

  function anchorFromHash(hash: { toString(): string }): Anchor {
    const h = str(hash);
    const proposed = sniffer.latestProposed();
    const ringEntry = sniffer.ringEntries().find(([, h2]) => h2 === h);
    if (ringEntry) return { number: ringEntry[0]!, hash: h };
    if (proposed && proposed.hash === h) return { number: proposed.number, hash: h };
    // Unknown height: sentinel that defeats block-bounded promotion. The
    // anchor-keyed cache still works since speculative entries are keyed
    // by hash, and reorg-eviction will catch them correctly.
    return { number: Number.MAX_SAFE_INTEGER, hash: h };
  }

  function tryAnchorFromBlockParameter(p: unknown): Anchor | undefined {
    if (p && typeof p === "object" && "hash" in p) {
      return anchorFromHash((p as { hash: { toString(): string } }).hash);
    }
    if (typeof p === "string") {
      if (
        p === "latest" ||
        p === "proposed" ||
        p === "checkpointed" ||
        p === "proven" ||
        p === "finalized"
      ) {
        return undefined;
      }
      return anchorFromHash(p);
    }
    if (typeof p === "object" && p !== null && "toString" in p) {
      return anchorFromHash(p as { toString(): string });
    }
    return undefined;
  }

  // ---- Cache primitives ----------------------------------------------

  function getAnchored<V>(key: string, anchor: Anchor): V | undefined {
    const perm = cache.getPermanent(key) as V | undefined;
    if (perm !== undefined) {
      const ringStill = sniffer.isAnchorStillValid(anchor.number, anchor.hash);
      if (ringStill === false) return undefined;
      return perm;
    }
    const spec = cache.getSpeculative(key, anchor.hash) as V | undefined;
    if (spec === undefined) return undefined;
    const ringStill = sniffer.isAnchorStillValid(anchor.number, anchor.hash);
    if (ringStill === false) return undefined;
    return spec;
  }

  function setAnchored<V>(key: string, value: V, anchor: Anchor): void {
    const finalizedAt = sniffer.latestFinalizedAt();
    if (finalizedAt !== undefined && anchor.number <= finalizedAt) {
      cache.setPermanent(key, value as unknown);
    } else {
      cache.setSpeculative(key, value as unknown, anchor.number, anchor.hash);
    }
  }

  async function dedup<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return (await inflight.run(key, fn as () => Promise<unknown>)) as T;
  }

  /**
   * Per-element batch resolver. Caller supplies the batch's inputs and a
   * `keyFn` per element. We check each element against the anchored cache,
   * fetch any missing in one upstream call (deduped against concurrent
   * requesters), and cache the results.
   */
  async function batched<I, R>(
    methodName: string,
    inputs: I[],
    keyFn: (i: I) => string,
    anchor: Anchor,
    fetch: (missing: I[]) => Promise<R[]>,
  ): Promise<R[]> {
    const out = new Array<R | undefined>(inputs.length);
    const missingIdx: number[] = [];
    const missingInputs: I[] = [];
    const elem = elementCounter(methodName);
    counter(methodName).calls++;

    for (let i = 0; i < inputs.length; i++) {
      elem.seen++;
      const cached = getAnchored<R>(keyFn(inputs[i]!), anchor);
      if (cached !== undefined) {
        elem.hits++;
        out[i] = cached;
      } else {
        missingIdx.push(i);
        missingInputs.push(inputs[i]!);
      }
    }

    if (missingInputs.length === 0) {
      counter(methodName).hits++;
      return out as R[];
    }

    if (missingInputs.length === inputs.length) counter(methodName).misses++;
    else counter(methodName).hits++;

    counter(methodName).upstream++;
    const fetched = await fetch(missingInputs);
    if (fetched.length !== missingInputs.length) {
      throw new Error(
        `Upstream returned ${fetched.length} results for ${missingInputs.length} inputs (batched call); refusing to cache partial response.`,
      );
    }
    for (let j = 0; j < missingIdx.length; j++) {
      const i = missingIdx[j]!;
      const v = fetched[j]!;
      out[i] = v;
      setAnchored(keyFn(inputs[i]!), v, anchor);
    }
    return out as R[];
  }

  async function anchoredSingle<R>(
    methodName: string,
    args: unknown[],
    referenceBlockIdx: number,
    keyOf: (args: unknown[]) => (a: Anchor) => string,
    bound: (...a: unknown[]) => Promise<R>,
  ): Promise<R | undefined> {
    const c = counter(methodName);
    c.calls++;
    const anchor = tryAnchorFromBlockParameter(args[referenceBlockIdx]);
    if (!anchor) {
      c.upstream++;
      return (await bound(...args)) as R;
    }
    const key = keyOf(args)(anchor);
    const cached = getAnchored<R>(key, anchor);
    if (cached !== undefined) {
      c.hits++;
      return cached;
    }
    c.misses++;
    c.upstream++;
    const res = await dedup(`single|${key}`, () => bound(...args));
    if (res !== undefined) setAnchored(key, res, anchor);
    return res as R;
  }

  // ---- Tip sniffing --------------------------------------------------

  function noteFromTipsResponse(res: unknown): void {
    if (!res || typeof res !== "object") return;
    const t = res as {
      proposed?: { number?: number | bigint; hash?: string | { toString(): string } };
      proven?: { block?: { number?: number | bigint; hash?: string | { toString(): string } } };
      finalized?: {
        block?: { number?: number | bigint; hash?: string | { toString(): string } };
      };
    };
    const obs: TipObservation = {};
    if (t.proposed?.number !== undefined && t.proposed.hash !== undefined) {
      obs.proposed = { number: Number(t.proposed.number), hash: str(t.proposed.hash) };
    }
    if (t.proven?.block?.number !== undefined && t.proven.block.hash !== undefined) {
      obs.proven = { number: Number(t.proven.block.number), hash: str(t.proven.block.hash) };
    }
    if (t.finalized?.block?.number !== undefined && t.finalized.block.hash !== undefined) {
      obs.finalized = {
        number: Number(t.finalized.block.number),
        hash: str(t.finalized.block.hash),
      };
    }
    if (obs.proposed || obs.proven || obs.finalized) sniffer.noteTips(obs);
  }

  function noteFromBlockResponse(res: unknown): void {
    if (!res || typeof res !== "object") return;
    const r = res as {
      number?: number | bigint;
      hash?: string | { toString(): string };
    };
    if (r.number !== undefined && r.hash !== undefined) {
      sniffer.notePinnedBlock(Number(r.number), str(r.hash));
    }
  }

  // ---- Handlers ------------------------------------------------------

  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async getPrivateLogsByTags(...args: unknown[]) {
      const tags = args[0] as Array<{ toString(): string }>;
      const page = (args[1] as number | undefined) ?? 0;
      const referenceBlock = args[2] as { toString(): string } | undefined;
      if (!referenceBlock) return await u.getPrivateLogsByTags(...args);
      const anchor = anchorFromHash(referenceBlock);
      const p = Number(page ?? 0);

      const c = counter("getPrivateLogsByTags");
      c.calls++;
      // Read-and-clear the warm flag SYNCHRONOUSLY before any await so
      // back-to-back warm calls (Promise.all fanout) are attributed
      // correctly. PXE never sets this flag.
      const isWarm = consumeWarmFlag();
      const elem = elementCounter("getPrivateLogsByTags");

      // Diagnostic: when every tag in a batch misses (full-miss), emit a
      // one-line console.info with the first tag value, the page number,
      // and the batch size. Captured by the testnet e2e to surface
      // *which* tag value PXE asked for that the warmer didn't cover —
      // the key signal for "warm enumeration ≠ PXE enumeration".
      // Gated on a global flag set by registerNodeProxyInspector; in
      // production with no inspector this is a no-op fast-path.
      const diagMissLogger = (globalThis as { __nodeProxyDiagMiss?: (line: string) => void })
        .__nodeProxyDiagMiss;

      // Page > 0 or unknown anchor height — fall back to the anchor-keyed
      // cache. Block-bounded only works when we know the anchor's height
      // because we have to compare to `scannedAtBlock`.
      if (p !== 0 || anchor.number === Number.MAX_SAFE_INTEGER) {
        return await batched(
          "getPrivateLogsByTags",
          tags,
          (t) => k.privateLogByTag(str(t), p, anchor.hash),
          anchor,
          async (missing) =>
            (await dedup(
              `getPrivateLogsByTags|${anchor.hash}|${p}|${missing.map(str).sort().join(",")}`,
              () => u.getPrivateLogsByTags(missing, p, referenceBlock),
            )) as unknown[],
        );
      }

      // Block-bounded fast path. The node returns logs filtered by
      // `upToBlockNumber = referenceBlock.number`; PXE then filters again
      // client-side. So a cached response from scan at block M serves any
      // query at anchor ≤ M by filtering down to `blockNumber ≤ qBlock`.
      const filter = (logs: unknown[], qBlock: number) =>
        logs.filter((l) => {
          const bn = (l as { blockNumber?: number | bigint })?.blockNumber;
          if (bn === undefined || bn === null) return true;
          return Number(bn) <= qBlock;
        });

      const out = new Array<unknown[] | undefined>(tags.length);
      const missingIdx: number[] = [];
      const missingTags: Array<{ toString(): string }> = [];
      for (let i = 0; i < tags.length; i++) {
        elem.seen++;
        const hit = tagLogCache.get(str(tags[i]!), anchor.number, filter);
        if (hit !== undefined) {
          out[i] = hit;
          elem.hits++;
        } else {
          missingIdx.push(i);
          missingTags.push(tags[i]!);
        }
      }
      if (missingTags.length === 0) {
        c.hits++;
        bumpWarmStats(c, isWarm, "hit");
        return out as unknown[];
      }
      if (missingTags.length === tags.length) {
        c.misses++;
        bumpWarmStats(c, isWarm, "miss");
        // Diagnostic: every tag in this batch was uncached. Surface a
        // sample of the missed tag values so the test (or a developer
        // with the inspector running) can correlate them against what
        // the warmer derived — answers "why is hit rate not 100%".
        // Only log PXE-originated full-misses; warm misses are
        // expected (they're populating).
        if (diagMissLogger && !isWarm) {
          const sample = missingTags.slice(0, 3).map((t) => str(t));
          diagMissLogger(
            `full-miss page=${p} anchor=${anchor.number} size=${tags.length} sample=[${sample.join(",")}${tags.length > 3 ? ",…" : ""}]`,
          );
        }
      } else {
        c.hits++;
        bumpWarmStats(c, isWarm, "hit");
      }
      c.upstream++;

      // Fetch at the LATEST sniffed tip when we know one — extends the
      // cache entry's shelf-life across the next tip advance.
      const tip = sniffer.latestProposed();
      const fetchAnchorHash = tip?.hash ?? str(referenceBlock);
      const fetchAnchorNum = tip?.number ?? anchor.number;
      const fetched = (await dedup(
        `getPrivateLogsByTags|bbc|${fetchAnchorHash}|${p}|${missingTags
          .map(str)
          .sort()
          .join(",")}`,
        () => u.getPrivateLogsByTags(missingTags, p, fetchAnchorHash),
      )) as unknown[][];
      if (fetched.length !== missingTags.length) {
        throw new Error(
          `Upstream returned ${fetched.length} results for ${missingTags.length} inputs (block-bounded path).`,
        );
      }
      for (let j = 0; j < missingIdx.length; j++) {
        const i = missingIdx[j]!;
        const logs = fetched[j]!;
        tagLogCache.set(str(tags[i]!), logs, fetchAnchorNum);
        out[i] = fetchAnchorNum === anchor.number ? logs : filter(logs, anchor.number);
      }
      return out as unknown[];
    },

    async getPublicLogsByTagsFromContract(...args: unknown[]) {
      const contract = args[0] as { toString(): string };
      const tags = args[1] as Array<{ toString(): string }>;
      const page = (args[2] as number | undefined) ?? 0;
      const referenceBlock = args[3] as { toString(): string } | undefined;
      if (!referenceBlock) return await u.getPublicLogsByTagsFromContract(...args);
      const anchor = anchorFromHash(referenceBlock);
      const p = Number(page ?? 0);
      const c = str(contract);
      return await batched(
        "getPublicLogsByTagsFromContract",
        tags,
        (t) => k.publicLogByTag(c, str(t), p, anchor.hash),
        anchor,
        async (missing) =>
          (await dedup(
            `getPublicLogsByTagsFromContract|${c}|${anchor.hash}|${p}|${missing.map(str).sort().join(",")}`,
            () => u.getPublicLogsByTagsFromContract(contract, missing, p, referenceBlock),
          )) as unknown[],
      );
    },

    async findLeavesIndexes(...args: unknown[]) {
      const [referenceBlock, treeId, leaves] = args as [
        { toString(): string } | number,
        number,
        Array<{ toString(): string }>,
      ];
      const anchor = tryAnchorFromBlockParameter(referenceBlock);
      if (!anchor) return await u.findLeavesIndexes(...args);

      if (anchor.number === Number.MAX_SAFE_INTEGER) {
        return await batched(
          "findLeavesIndexes",
          leaves,
          (leaf) => k.leafIndex(Number(treeId), str(leaf), anchor.hash),
          anchor,
          async (missing) =>
            (await dedup(
              `findLeavesIndexes|${anchor.hash}|${treeId}|${missing.map(str).sort().join(",")}`,
              () => u.findLeavesIndexes(referenceBlock, treeId, missing),
            )) as unknown[],
        );
      }

      const c = counter("findLeavesIndexes");
      c.calls++;
      const elem = elementCounter("findLeavesIndexes");
      // Filter for the queried block: `undefined` (leaf not inserted by
      // M) is also `undefined` at any qBlock ≤ M; a defined entry whose
      // insertion block ≤ qBlock is still valid; one inserted AFTER
      // qBlock must drop.
      const filter = (v: unknown, qBlock: number) => {
        if (v === undefined) return v;
        const insertedBlock = (v as { block?: { number?: number | bigint } })?.block?.number;
        if (insertedBlock === undefined) return v;
        return Number(insertedBlock) <= qBlock ? v : undefined;
      };
      const out = new Array<unknown>(leaves.length);
      const missingIdx: number[] = [];
      const missingLeaves: typeof leaves = [];
      for (let i = 0; i < leaves.length; i++) {
        elem.seen++;
        const key = `${treeId}|${str(leaves[i]!)}`;
        const hit = leafIndexCache.get(key, anchor.number, filter);
        if (hit !== undefined) {
          out[i] = hit;
          elem.hits++;
        } else {
          missingIdx.push(i);
          missingLeaves.push(leaves[i]!);
        }
      }
      if (missingLeaves.length === 0) {
        c.hits++;
        return out;
      }
      if (missingLeaves.length === leaves.length) c.misses++;
      else c.hits++;
      c.upstream++;

      const tip = sniffer.latestProposed();
      const fetchAnchorHash = tip?.hash ?? str(referenceBlock as object);
      const fetchAnchorNum = tip?.number ?? anchor.number;
      const fetched = (await dedup(
        `findLeavesIndexes|bbc|${fetchAnchorHash}|${treeId}|${missingLeaves
          .map(str)
          .sort()
          .join(",")}`,
        () => u.findLeavesIndexes(fetchAnchorHash, treeId, missingLeaves),
      )) as unknown[];
      if (fetched.length !== missingLeaves.length) {
        throw new Error(
          `Upstream returned ${fetched.length} results for ${missingLeaves.length} leaves.`,
        );
      }
      for (let j = 0; j < missingIdx.length; j++) {
        const i = missingIdx[j]!;
        const v = fetched[j];
        leafIndexCache.set(`${treeId}|${str(leaves[i]!)}`, v, fetchAnchorNum);
        out[i] = fetchAnchorNum === anchor.number ? v : filter(v, anchor.number);
      }
      return out;
    },

    async getNullifierMembershipWitness(...args: unknown[]) {
      return await anchoredSingle(
        "getNullifierMembershipWitness",
        args,
        0,
        ([_, nullifier]) => (a) => k.nullifierWitness(str(nullifier as object), a.hash),
        u.getNullifierMembershipWitness,
      );
    },

    async getLowNullifierMembershipWitness(...args: unknown[]) {
      return await anchoredSingle(
        "getLowNullifierMembershipWitness",
        args,
        0,
        ([_, nullifier]) => (a) => k.lowNullifierWitness(str(nullifier as object), a.hash),
        u.getLowNullifierMembershipWitness,
      );
    },

    async getNoteHashMembershipWitness(...args: unknown[]) {
      return await anchoredSingle(
        "getNoteHashMembershipWitness",
        args,
        0,
        ([_, noteHash]) => (a) => k.noteHashWitness(str(noteHash as object), a.hash),
        u.getNoteHashMembershipWitness,
      );
    },

    async getPublicDataWitness(...args: unknown[]) {
      return await anchoredSingle(
        "getPublicDataWitness",
        args,
        0,
        ([_, leafSlot]) => (a) => k.publicDataWitness(str(leafSlot as object), a.hash),
        u.getPublicDataWitness,
      );
    },

    async getPublicStorageAt(...args: unknown[]) {
      // Two-layer caching:
      //   1. Anchor-keyed (via anchoredSingle): exact-same `(contract,
      //      slot, anchorHash)` queries hit. Safe forever within that
      //      cache tier.
      //   2. Short-TTL on `(contract, slot)` alone, ignoring anchor:
      //      catches PXE's pattern of re-querying the same slot across
      //      sim → prove → sendTx phases where the anchor block drifts
      //      a few blocks between phases. Bounds staleness to
      //      PUBLIC_STORAGE_TTL_MS; the slot CAN change per block, so
      //      we keep this short.
      const c = counter("getPublicStorageAt");
      const [_refBlock, contract, slot] = args as unknown[];
      const noAnchorKey = `${str(contract as object)}|${str(slot as object)}`;
      const ttlHit = ttlGet<unknown>(publicStorageTtlCache, noAnchorKey);
      if (ttlHit !== undefined) {
        c.calls++;
        c.hits++;
        return ttlHit;
      }
      // anchoredSingle increments calls/hits/misses/upstream internally.
      const res = await anchoredSingle(
        "getPublicStorageAt",
        args,
        0,
        ([_, c2, s2]) => (a) =>
          k.publicStorage(str(c2 as object), str(s2 as object), a.hash),
        u.getPublicStorageAt,
      );
      if (res !== undefined) ttlSet(publicStorageTtlCache, noAnchorKey, res, PUBLIC_STORAGE_TTL_MS);
      return res;
    },

    async getTxReceipt(...args: unknown[]) {
      const c = counter("getTxReceipt");
      c.calls++;
      const [txHash] = args as [{ toString(): string }];
      const key = k.txReceipt(str(txHash));

      // Permanent first: finalized receipts can never change.
      const perm = cache.getPermanent(key);
      if (perm !== undefined) {
        c.hits++;
        return perm;
      }
      // Short-TTL fast path: PXE's `get_status_change_of_pending` polls
      // the same hashes dozens of times inside one simulator run; a
      // 1-second cache window collapses those redundant calls. A
      // status change is observed at most TX_RECEIPT_TTL_MS late.
      const ttlHit = ttlGet<unknown>(txReceiptTtlCache, key);
      if (ttlHit !== undefined) {
        c.hits++;
        return ttlHit;
      }
      c.misses++;
      c.upstream++;
      const res = await dedup(`getTxReceipt|${str(txHash)}`, () => u.getTxReceipt(...args));
      const r = res as { status?: string } | undefined;
      if (r && r.status === "finalized") {
        cache.setPermanent(key, res);
        txReceiptTtlCache.delete(key);
      } else if (res !== undefined) {
        // Anything pre-finalized — cache for TX_RECEIPT_TTL_MS so
        // PXE's burst of polls hits. Includes pending, proposed, proven
        // (proven can reorg before L1 finality; TTL bounds staleness).
        ttlSet(txReceiptTtlCache, key, res, TX_RECEIPT_TTL_MS);
      }
      return res;
    },

    async getTxEffect(...args: unknown[]) {
      const c = counter("getTxEffect");
      c.calls++;
      const [txHash] = args as [{ toString(): string }];
      const key = k.txEffect(str(txHash));

      const perm = cache.getPermanent(key);
      if (perm !== undefined) {
        c.hits++;
        return perm;
      }
      const ttlHit = ttlGet<unknown>(txEffectTtlCache, key);
      if (ttlHit !== undefined) {
        c.hits++;
        return ttlHit;
      }
      c.misses++;
      c.upstream++;
      const res = await dedup(`getTxEffect|${str(txHash)}`, () => u.getTxEffect(...args));
      const r = res as
        | {
            blockNumber?: number | bigint;
            data?: { blockNumber?: number | bigint };
          }
        | undefined;
      const blockNumber =
        r?.blockNumber !== undefined
          ? Number(r.blockNumber)
          : r?.data?.blockNumber !== undefined
            ? Number(r.data.blockNumber)
            : undefined;
      const finalizedAt = sniffer.latestFinalizedAt();
      if (
        res !== undefined &&
        blockNumber !== undefined &&
        finalizedAt !== undefined &&
        blockNumber <= finalizedAt
      ) {
        cache.setPermanent(key, res);
        txEffectTtlCache.delete(key);
      } else if (res !== undefined) {
        // Effect is content-addressed: once a tx is in block M, the
        // effect is fixed until reorg crosses M. Long TTL is safe;
        // reorg eviction by the sniffer would handle the rare unsafe
        // case via permanent-tier cache invalidation, but pre-finality
        // effects don't live in permanent, so we accept TX_EFFECT_TTL_MS
        // of potential staleness on reorg.
        ttlSet(txEffectTtlCache, key, res, TX_EFFECT_TTL_MS);
      }
      return res;
    },

    async getContract(...args: unknown[]) {
      const c = counter("getContract");
      c.calls++;
      const [address] = args as [{ toString(): string }];
      const key = k.contract(str(address));
      const cached = cache.getPermanent(key);
      if (cached !== undefined) {
        c.hits++;
        return cached;
      }
      c.misses++;
      c.upstream++;
      const res = await dedup(`getContract|${str(address)}`, () => u.getContract(...args));
      if (res !== undefined) cache.setPermanent(key, res);
      return res;
    },

    async getContractClass(...args: unknown[]) {
      const c = counter("getContractClass");
      c.calls++;
      const [id] = args as [{ toString(): string }];
      const key = k.contractClass(str(id));
      const cached = cache.getPermanent(key);
      if (cached !== undefined) {
        c.hits++;
        return cached;
      }
      c.misses++;
      c.upstream++;
      const res = await dedup(`getContractClass|${str(id)}`, () => u.getContractClass(...args));
      if (res !== undefined) cache.setPermanent(key, res);
      return res;
    },

    async getL2Tips(...args: unknown[]) {
      // No caching: the reorg sniffer needs to see every tips
      // observation to detect head reorgs promptly. Saving a few RPCs
      // here isn't worth a window of reorg-blindness.
      const c = counter("getL2Tips");
      c.calls++;
      c.upstream++;
      const res = await u.getL2Tips(...args);
      noteFromTipsResponse(res);
      return res;
    },

    async getBlock(...args: unknown[]) {
      const c = counter("getBlock");
      c.calls++;
      c.upstream++;
      const res = await u.getBlock(...args);
      noteFromBlockResponse(res);
      return res;
    },

    async getBlocks(...args: unknown[]) {
      const c = counter("getBlocks");
      c.calls++;
      c.upstream++;
      const res = await u.getBlocks(...args);
      if (Array.isArray(res)) for (const b of res) noteFromBlockResponse(b);
      return res;
    },

    async getBlockHeader(...args: unknown[]) {
      const c = counter("getBlockHeader");
      c.calls++;
      c.upstream++;
      return await u.getBlockHeader(...args);
    },
  };

  // ---- Public surface ------------------------------------------------

  const internals = {
    __cachingProxy: true as const,
    /**
     * Set immediately before a warm-originated call. Consumed
     * synchronously by the next `getPrivateLogsByTags` handler entry.
     * Safe under Promise.all fanout because each .map callback runs
     * synchronously up to the handler's first await (mark+call pair).
     */
    __markNextAsWarm(): void {
      nextCallIsWarm = true;
    },
    stats(): CacheStats {
      const s = cache.sizes();
      const methods: Record<string, MethodCounters> = {};
      for (const [name, c] of Object.entries(counters)) {
        methods[name] = {
          calls: c.calls,
          hits: c.hits,
          misses: c.misses,
          upstream: c.upstream,
          elements: c.elements ? { ...c.elements } : undefined,
          warmCalls: c.warmCalls,
          warmHits: c.warmHits,
          warmMisses: c.warmMisses,
        };
      }
      return {
        permanent: s.permanent,
        speculative: s.speculative,
        tagLogBlockBounded: tagLogCache.size(),
        leafIndexBlockBounded: leafIndexCache.size(),
        ringSize: sniffer.ringSize(),
        provenAt: sniffer.latestProvenAt(),
        finalizedAt: sniffer.latestFinalizedAt(),
        proposed: sniffer.latestProposed(),
        methods,
      };
    },
    // Test/internal probe.
    __testing_internals: { sniffer, cache, inflight },
  };

  const proxy = new Proxy(upstream, {
    get(target: AztecNode, prop: string | symbol, receiver: unknown) {
      if (typeof prop === "string" && prop in internals) {
        return (internals as unknown as Record<string, unknown>)[prop];
      }
      if (typeof prop === "string" && handlers[prop]) return handlers[prop];
      return Reflect.get(target as object, prop, receiver);
    },
  }) as CachingNodeProxy;

  return proxy;
}
