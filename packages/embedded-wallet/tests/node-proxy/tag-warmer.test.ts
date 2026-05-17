/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tag-warmer unit tests.
 *
 * The warmer is the active half of the caching design: it derives every
 * tag PXE will eventually scan and batch-fetches them in parallel so the
 * proxy's caches are populated before any PXE sim runs.
 *
 * Catastrophic-correctness invariants exercised here:
 *
 *   • A single warm enumerates EVERY (recipient × {accounts ∪ senders} ×
 *     contract) triple and over a `windowSize` of indices. Missing any
 *     triple means cache miss → PXE roundtrip during the sim → user-
 *     visible latency.
 *   • Sender duplicate dedup: `accounts ∪ senders` may overlap; we
 *     enumerate once.
 *   • Tags are issued in ≤MAX_TAGS_PER_RPC batches, all in parallel — no
 *     sequential dispatch.
 *   • Failures in one batch do not abort the others.
 */
import { describe, expect, it, vi } from "vitest";

import { Fq } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { CompleteAddress } from "@aztec/stdlib/contract";

import { createCachingNodeProxy } from "../../src/node-proxy/caching-node-proxy";
import { warmTags } from "../../src/node-proxy/tag-warmer";
import type { RecipientKeyMaterial } from "../../src/node-proxy/tag-derivation";

async function makeRecipient(): Promise<RecipientKeyMaterial> {
  const completeAddress = await CompleteAddress.random();
  return {
    address: completeAddress.address,
    completeAddress,
    ivsk: Fq.random(),
  };
}

/**
 * Produce an `AztecAddress` whose underlying Fr is a valid x-coordinate
 * on the Grumpkin curve. `AztecAddress.fromBigInt(1n)` is NOT guaranteed
 * to be — `ExtendedDirectionalAppTaggingSecret.compute` returns
 * `undefined` for those, which the warmer correctly skips.
 *
 * `CompleteAddress.random()` does the curve work for us; we just take
 * the resulting `address`.
 */
async function validAddress(): Promise<AztecAddress> {
  const ca = await CompleteAddress.random();
  return ca.address;
}

function makeMockNode(): {
  node: any;
  calls: { getPrivateLogsByTags: number; tagsSeen: number; batches: number[] };
} {
  const calls = { getPrivateLogsByTags: 0, tagsSeen: 0, batches: [] as number[] };
  const node: any = {
    getL2Tips: async () => ({ proposed: { number: 1, hash: "h1" } }),
    getPrivateLogsByTags: async (
      tags: Array<{ toString(): string }>,
      _page = 0,
      _anchor?: unknown,
    ) => {
      calls.getPrivateLogsByTags++;
      calls.tagsSeen += tags.length;
      calls.batches.push(tags.length);
      return tags.map(() => []);
    },
  };
  return { node, calls };
}

describe("warmTags", () => {
  it("derives every (recipient × {accounts ∪ senders} × app) × index — no missing triples", async () => {
    const upstream = makeMockNode();
    const proxy = createCachingNodeProxy(upstream.node);
    await (proxy as any).getL2Tips(); // prime sniffer with proposed=1/h1

    const recipientA = await makeRecipient();
    const recipientB = await makeRecipient();
    const sender = await validAddress();
    const app1 = await validAddress();
    const app2 = await validAddress();

    const result = await warmTags({
      proxy,
      accounts: [recipientA, recipientB],
      senders: [sender],
      contracts: [app1, app2],
      anchorHash: "h1",
      windowSize: 5,
    });

    // 2 accounts × (1 sender + 2 self-accounts) × 2 apps = 12 triples.
    // Each triple is one batched RPC of its `windowSize` tags.
    expect(result.triples).toBe(12);
    expect(result.tagsQueried).toBe(60); // 12 × 5
    expect(result.rpcBatches).toBe(12); // one per triple
    expect(upstream.calls.tagsSeen).toBe(60);
  });

  it("dedupes senders ∪ accounts (an account that's also a registered sender is enumerated once)", async () => {
    const upstream = makeMockNode();
    const proxy = createCachingNodeProxy(upstream.node);
    await (proxy as any).getL2Tips();

    const recipient = await makeRecipient();
    const app = await validAddress();

    const result = await warmTags({
      proxy,
      accounts: [recipient],
      // recipient.address ALSO appears in senders — must not double-count.
      senders: [recipient.address],
      contracts: [app],
      anchorHash: "h1",
      windowSize: 3,
    });

    // 1 recipient × 1 sender (recipient and the dup collapse) × 1 app = 1 triple
    expect(result.triples).toBe(1);
    expect(result.tagsQueried).toBe(3);
  });

  it("fires one batched RPC per triple, all in flight at the same time", async () => {
    // Each (sender, recipient, app) triple is one batched RPC carrying
    // up to MAX_RPC_LEN (=100) tags. With N triples, we expect N
    // concurrent RPCs — sequential dispatch would yield maxConcurrent=1.
    const upstream = makeMockNode();
    let inflight = 0;
    let maxConcurrent = 0;
    upstream.node.getPrivateLogsByTags = async (
      tags: Array<{ toString(): string }>,
    ) => {
      inflight++;
      maxConcurrent = Math.max(maxConcurrent, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      upstream.calls.getPrivateLogsByTags++;
      upstream.calls.tagsSeen += tags.length;
      upstream.calls.batches.push(tags.length);
      return tags.map(() => []);
    };

    const proxy = createCachingNodeProxy(upstream.node);
    await (proxy as any).getL2Tips();

    const recipient = await makeRecipient();
    const senders = await Promise.all(
      Array.from({ length: 5 }, () => validAddress()),
    );
    const app = await validAddress();

    const result = await warmTags({
      proxy,
      accounts: [recipient],
      senders,
      contracts: [app],
      anchorHash: "h1",
      windowSize: 50,
    });

    // 5 explicit senders + 1 account-as-self = 6 sender entries
    // × 1 recipient × 1 app = 6 triples × 50 indices = 300 tags
    // → 6 batches (one per triple).
    expect(result.tagsQueried).toBe(300);
    expect(result.rpcBatches).toBe(6);
    // All 6 in flight together — adaptive scanning still parallelises
    // ACROSS triples; only EXTENSION ROUNDS for one triple serialise.
    expect(maxConcurrent).toBe(6);
  });

  it("a single failing triple does not abort the rest", async () => {
    // With per-triple scanning, a triple's RPC failure terminates just
    // that triple early. The others complete their (successful) round.
    const upstream = makeMockNode();
    let attempt = 0;
    upstream.node.getPrivateLogsByTags = async (
      tags: Array<{ toString(): string }>,
    ) => {
      attempt++;
      if (attempt === 2) throw new Error("simulated upstream failure");
      upstream.calls.getPrivateLogsByTags++;
      upstream.calls.tagsSeen += tags.length;
      return tags.map(() => []);
    };

    const proxy = createCachingNodeProxy(upstream.node);
    await (proxy as any).getL2Tips();

    const recipient = await makeRecipient();
    const senders = await Promise.all([validAddress(), validAddress(), validAddress()]);
    const app = await validAddress();
    const errs: string[] = [];

    const result = await warmTags({
      proxy,
      accounts: [recipient],
      senders,
      contracts: [app],
      anchorHash: "h1",
      windowSize: 100,
      log: (m) => errs.push(m),
    });

    // 3 explicit senders + 1 account-as-self = 4 triples. The mock
    // throws on the 2nd attempt; the warmer only counts SUCCESSFUL
    // batches in rpcBatches, so 3 of 4 land. Upstream itself sees 3
    // successful calls (the failure didn't reach the success-counter).
    expect(result.rpcBatches).toBe(3);
    expect(upstream.calls.getPrivateLogsByTags).toBe(3);
    // The failure was logged through the per-triple error path.
    expect(errs.some((m) => m.toLowerCase().includes("rpc failed"))).toBe(true);
  });

  it("returns immediately with empty result if no accounts are supplied", async () => {
    const upstream = makeMockNode();
    const proxy = createCachingNodeProxy(upstream.node);
    await (proxy as any).getL2Tips();

    const result = await warmTags({
      proxy,
      accounts: [],
      senders: [AztecAddress.fromBigInt(1n)],
      contracts: [AztecAddress.fromBigInt(2n)],
      anchorHash: "h1",
    });
    expect(result.triples).toBe(0);
    expect(upstream.calls.getPrivateLogsByTags).toBe(0);
  });

  it("populates the proxy cache so a subsequent PXE-side query is a hit (the whole point)", async () => {
    // The mock returns ONE log at index 0 only — enough to exercise
    // the "has hits" path without forcing runaway extension (which
    // would happen if every tag returned logs, since activity in the
    // upper PXE_WINDOW_LEN triggers another round).
    const { computeSiloedTagsForWindow } = await import(
      "../../src/node-proxy/tag-derivation"
    );

    const upstream = makeMockNode();
    const recipient = await makeRecipient();
    const sender = await validAddress();
    const app = await validAddress();

    // Pre-compute the index-0 tag for ONE triple so the mock can match.
    const targetTag = (await computeSiloedTagsForWindow(
      recipient,
      sender,
      app,
      0,
      1,
    ))![0]!.toString();

    upstream.node.getPrivateLogsByTags = async (
      tags: Array<{ toString(): string }>,
    ) => {
      upstream.calls.getPrivateLogsByTags++;
      upstream.calls.tagsSeen += tags.length;
      return tags.map((t) =>
        t.toString() === targetTag ? [{ txHash: "tx-0", blockNumber: 1 }] : [],
      );
    };

    const proxy = createCachingNodeProxy(upstream.node);
    await (proxy as any).getL2Tips();

    // Warm: 2 triples (sender + account-as-self) × 1 window each = 2 batches.
    await warmTags({
      proxy,
      accounts: [recipient],
      senders: [sender],
      contracts: [app],
      anchorHash: "h1",
      windowSize: 100,
    });
    const upstreamAfterWarm = upstream.calls.getPrivateLogsByTags;
    expect(upstreamAfterWarm).toBe(2);

    // Now query the SAME tag PXE would compute. Hits cache.
    const tags = await computeSiloedTagsForWindow(recipient, sender, app, 0, 1);
    expect(tags).toBeDefined();
    const result = await (proxy as any).getPrivateLogsByTags(tags!, 0, "h1");
    expect(Array.isArray(result)).toBe(true);
    expect(upstream.calls.getPrivateLogsByTags).toBe(upstreamAfterWarm); // No extra call.
  });

  it("non-array `senders` and empty `contracts` produce no work without crashing", async () => {
    const upstream = makeMockNode();
    const proxy = createCachingNodeProxy(upstream.node);
    await (proxy as any).getL2Tips();

    const recipient = await makeRecipient();
    const result = await warmTags({
      proxy,
      accounts: [recipient],
      senders: [],
      contracts: [],
      anchorHash: "h1",
    });
    // No senders besides the account itself, no apps → 0 triples.
    expect(result.triples).toBe(0);
    expect(upstream.calls.getPrivateLogsByTags).toBe(0);
  });
});

/**
 * Index drift: PXE's scan window is `(highestFinalizedIndex, +WINDOW_LEN]`
 * with `WINDOW_LEN=20`. When prior activity (this wallet on another
 * device, an external counterparty, etc.) has driven the index up,
 * PXE will scan well above 0 on next sim. A fixed `[0, K)` warm misses
 * those tags. The warmer must extend its scan adaptively so the union
 * of cached indices covers every window PXE could land on.
 */
describe("warmTags — index drift across devices / chain history", () => {
  /**
   * Plant activity at a chosen index by configuring the mock to return
   * a single log entry when queried for that exact siloed-tag value.
   * Returns the upstream call counter so tests can assert "no extra
   * upstream call" after a PXE-style probe.
   */
  async function mockNodeWithActivityAt(
    recipient: RecipientKeyMaterial,
    sender: AztecAddress,
    app: AztecAddress,
    activityIndex: number,
  ): Promise<{ node: any; activityTagStr: string; getCalls: () => number }> {
    const activityTag = (await import("../../src/node-proxy/tag-derivation"))
      .computeSiloedTagsForWindow;
    const tags = await activityTag(recipient, sender, app, activityIndex, 1);
    if (!tags) throw new Error("could not derive activity tag");
    const activityTagStr = tags[0]!.toString();
    let calls = 0;
    const node: any = {
      getL2Tips: async () => ({ proposed: { number: 10, hash: "h-tip" } }),
      getPrivateLogsByTags: async (qtags: Array<{ toString(): string }>) => {
        calls++;
        return qtags.map((t) =>
          t.toString() === activityTagStr
            ? [{ txHash: `tx-at-${activityIndex}`, blockNumber: 5 }]
            : [],
        );
      },
    };
    return { node, activityTagStr, getCalls: () => calls };
  }

  /** Width of PXE's scan window — matches `UNFINALIZED_TAGGING_INDEXES_WINDOW_LEN`. */
  const PXE_WINDOW_LEN = 20;

  it("covers PXE's `(N, N + WINDOW_LEN]` scan when activity sits well inside the initial range", async () => {
    // Activity at index 50 is far below the 100-window's upper edge.
    // No extension needed; PXE's scan (50, 70] is already in cache.
    const recipient = await makeRecipient();
    const sender = await validAddress();
    const app = await validAddress();
    const m = await mockNodeWithActivityAt(recipient, sender, app, 50);
    const proxy = createCachingNodeProxy(m.node);
    await (proxy as any).getL2Tips();

    await warmTags({
      proxy,
      accounts: [recipient],
      senders: [sender],
      contracts: [app],
      anchorHash: "h-tip",
      windowSize: 100,
    });
    const callsAfterWarm = m.getCalls();
    expect(callsAfterWarm).toBeGreaterThan(0);

    // PXE-style probe of (50, 70].
    const { computeSiloedTagsForWindow } = await import(
      "../../src/node-proxy/tag-derivation"
    );
    const probe = await computeSiloedTagsForWindow(
      recipient,
      sender,
      app,
      51,
      PXE_WINDOW_LEN,
    );
    expect(probe).toBeDefined();
    await (proxy as any).getPrivateLogsByTags(probe!, 0, "h-tip");
    expect(m.getCalls()).toBe(callsAfterWarm); // No extra upstream call.
  });

  it("EXTENDS the warm when activity is near the upper edge of the initial window", async () => {
    // Activity at index 87 → PXE's next scan is (87, 107]. The initial
    // [0, 100) window does NOT cover 100..107. The warmer must detect
    // that activity sits inside the last WINDOW_LEN indices and extend.
    const recipient = await makeRecipient();
    const sender = await validAddress();
    const app = await validAddress();
    const m = await mockNodeWithActivityAt(recipient, sender, app, 87);
    const proxy = createCachingNodeProxy(m.node);
    await (proxy as any).getL2Tips();

    await warmTags({
      proxy,
      accounts: [recipient],
      senders: [sender],
      contracts: [app],
      anchorHash: "h-tip",
      windowSize: 100,
    });
    const callsAfterWarm = m.getCalls();

    const { computeSiloedTagsForWindow } = await import(
      "../../src/node-proxy/tag-derivation"
    );
    // PXE's scan (87, 107] — indices 88..107.
    const probe = await computeSiloedTagsForWindow(
      recipient,
      sender,
      app,
      88,
      PXE_WINDOW_LEN,
    );
    expect(probe).toBeDefined();
    await (proxy as any).getPrivateLogsByTags(probe!, 0, "h-tip");
    expect(m.getCalls()).toBe(callsAfterWarm); // Adaptive extension cached the spillover.
  });

  it("KEEPS extending until a full WINDOW_LEN-wide empty tail above the highest activity", async () => {
    // Activity at index 250 → forces extension through several rounds:
    //   round 1: [0, 100) — empty → no extension yet (no activity seen)
    //   ⟹ but with no activity seen anywhere, we shouldn't extend at all
    // Actually the harder case: activity at index 199 — initial [0,100) is empty,
    // we'd stop there and miss the activity entirely.
    //
    // The right contract: extension is BOUNDED — if no activity is seen
    // in the initial window, we DON'T blindly extend forever. The warmer
    // is for "warm up where PXE would scan from highestFinalized"; on a
    // cold device PXE starts at 0 anyway, so initial window covers it.
    //
    // The non-trivial case is "we DID see activity, and it was near the
    // edge". Plant activity at index 195 with windowSize=100:
    //   round 1: [0, 100) — empty, no extension
    // ⟹ this test should NOT extend. (External-device drift beyond the
    // initial window without ANY activity in [0, K) is a real edge case
    // we explicitly accept — PXE's first scan after fresh boot also
    // starts at 0, so the same logs would be missed by PXE itself.)
    //
    // The MULTI-EXTEND case is "activity stacks": indices 95, 197, 299 —
    // each round near the edge → each triggers another extension.
    const recipient = await makeRecipient();
    const sender = await validAddress();
    const app = await validAddress();
    const { computeSiloedTagsForWindow } = await import(
      "../../src/node-proxy/tag-derivation"
    );
    const tag95 = (await computeSiloedTagsForWindow(recipient, sender, app, 95, 1))![0]!;
    const tag197 = (await computeSiloedTagsForWindow(recipient, sender, app, 197, 1))![0]!;
    const tag299 = (await computeSiloedTagsForWindow(recipient, sender, app, 299, 1))![0]!;
    const activitySet = new Set([tag95.toString(), tag197.toString(), tag299.toString()]);
    let calls = 0;
    const node: any = {
      getL2Tips: async () => ({ proposed: { number: 10, hash: "h-tip" } }),
      getPrivateLogsByTags: async (qtags: Array<{ toString(): string }>) =>
        (calls++, qtags.map((t) =>
          activitySet.has(t.toString()) ? [{ txHash: "tx", blockNumber: 5 }] : [],
        )),
    };
    const proxy = createCachingNodeProxy(node);
    await (proxy as any).getL2Tips();

    await warmTags({
      proxy,
      accounts: [recipient],
      senders: [sender],
      contracts: [app],
      anchorHash: "h-tip",
      windowSize: 100,
    });
    const callsAfterWarm = calls;

    // PXE will eventually scan (299, 319]. With three extensions
    // (95→195, 197→297, 299→399), the warmer should have covered it.
    const probe = await computeSiloedTagsForWindow(
      recipient,
      sender,
      app,
      300,
      PXE_WINDOW_LEN,
    );
    expect(probe).toBeDefined();
    await (proxy as any).getPrivateLogsByTags(probe!, 0, "h-tip");
    expect(calls).toBe(callsAfterWarm);
  });

  /**
   * Contract pin: our derivation MUST be byte-equivalent to PXE's. If a
   * future stdlib bump renames a parameter or changes a domain
   * separator, every warmed tag would silently miss the cache.
   *
   * We reproduce PXE's own derivation from
   * `pxe/dest/logs/log_service.js:62` (`#getSecretsForSenders`) directly
   * using the imported stdlib classes, then compare to ours. If THIS
   * test ever fails, the warm-up is no longer doing what PXE does and
   * the cache hit rate will collapse to zero.
   */
  it("derives EXACTLY the tag value PXE's #getSecretsForSenders would scan", async () => {
    const { ExtendedDirectionalAppTaggingSecret, SiloedTag } = await import(
      "@aztec/stdlib/logs"
    );
    const { computeSiloedTagsForWindow } = await import(
      "../../src/node-proxy/tag-derivation"
    );

    const recipient = await makeRecipient();
    const sender = await validAddress();
    const app = await validAddress();
    const index = 42;

    // What PXE computes (reproduced inline from log_service.js:62 +
    // sync_tagged_private_logs.js:106).
    const pxeSecret = await ExtendedDirectionalAppTaggingSecret.compute(
      recipient.completeAddress,
      recipient.ivsk,
      sender,
      app,
      recipient.address,
    );
    expect(pxeSecret).toBeDefined();
    const pxeTag = await SiloedTag.compute({ extendedSecret: pxeSecret!, index });

    // What our warmer derives for the same triple at the same index.
    const ourTags = await computeSiloedTagsForWindow(recipient, sender, app, index, 1);
    expect(ourTags).toBeDefined();
    const ourTag = ourTags![0]!;

    // Byte-equivalent.
    expect(ourTag.toString()).toBe(pxeTag.toString());
  });

  it("does NOT extend when the initial window is fully empty (no activity → no work)", async () => {
    // Cold device, no on-chain history for this triple → initial scan
    // is empty → don't waste round-trips chasing nothing.
    const recipient = await makeRecipient();
    const sender = await validAddress();
    const app = await validAddress();
    let calls = 0;
    const node: any = {
      getL2Tips: async () => ({ proposed: { number: 10, hash: "h-tip" } }),
      getPrivateLogsByTags: async (qtags: Array<{ toString(): string }>) =>
        (calls++, qtags.map(() => [])),
    };
    const proxy = createCachingNodeProxy(node);
    await (proxy as any).getL2Tips();

    await warmTags({
      proxy,
      accounts: [recipient],
      senders: [sender],
      contracts: [app],
      anchorHash: "h-tip",
      windowSize: 100,
    });
    // 1 recipient × (1 explicit sender + 1 account-as-self) × 1 app = 2
    // triples → 2 batches, NO extension (every result was empty).
    expect(calls).toBe(2);
  });
});

void vi; // imported but only used implicitly in some configurations
