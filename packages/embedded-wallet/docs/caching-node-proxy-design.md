# Caching Aztec-node proxy for embedded wallets

Design for a transparent, reorg-correct caching proxy that sits between PXE and
the Aztec node to eliminate the RPC tail that dominates `simulateTx` / `proveTx`
on embedded wallets. No PXE modifications required; injected through the
existing `AztecNode` parameter of `EmbeddedWallet.create()`.

---

## 1. Profile-driven motivation

Source: `swap` profile, total wall-clock 87.7s for one swap.

### 1.1 Top-level breakdown

| Phase                                 | Time   | Notes                                              |
| ------------------------------------- | ------ | -------------------------------------------------- |
| `sendTx` (wallet root)                | 79.8s  | Whole flow: simulate + prove + submit + wait-mined |
| └─ `simulateViaEntrypoint`            | 4.0s   | Pre-prove simulation                               |
| └─ `proveTx` (pxe)                    | 21.4s  | Witgen + private-kernel proving                    |
| └─ post-`sendTx` poll loop            | ~52s   | `getTxReceipt` × 42, polled at ~1.1s interval      |
| Standalone `simulateTx` / `batch` etc | 7.2s   | Fee estimation, view calls                         |

The user's focus is `simulateTx` + `proveTx` (~25s); the post-submit polling tail
is a separate concern (addressed in §7 as a bonus).

### 1.2 Where the simulation+prove RPC time goes

Inside the `sim/*` and `pxe/{simulateTx,proveTx,executeUtility}` records:

| Top method            | Count | Total (ms) | Where it comes from                                                       |
| --------------------- | ----- | ---------- | ------------------------------------------------------------------------- |
| `getTxReceipt`        | 16¹   | ~2.5s      | sender-sync (`getStatusChangeOfPending`) for every (sender,recipient,app) |
| `getPrivateLogsByTags`| 20    | 2.96s      | tagged-log scan, paginated per secret                                     |
| `getPublicStorageAt`  | 24    | 3.74s      | utility/public view calls                                                 |
| `getTxEffect`         | 14    | 2.90s      | sender-sync revert reconciliation + `aztec_utl_getTxEffect`               |
| `findLeavesIndexes`   | 17    | 2.70s      | nullifier-existence checks, witness gen                                   |
| `getL2Tips`           | 9     | 1.45s      | once per `fetchTaggedLogs()` + per `getSyncedBlockHeader`                 |
| `getPublicDataWitness`| 7     | 1.23s      | witness gen in `proveTx`                                                  |
| `getNullifierMembershipWitness` | 5 | 0.77s   | witness gen in `proveTx`                                                  |
| `getNoteHashMembershipWitness`  | 2 | 0.31s   | witness gen in `proveTx`                                                  |

¹ Excluding the 42 polling-loop receipts that fire after `sendTx` submits.

### 1.3 Per-phase hot spots

- `sim/SubscriptionFPC:subscribe` — 21 RPC calls, 3.3s total node-call wait
  (the dominant single oracle execution).
- `sim/Token:sync_state`, `sim/SubscriptionFPC:sync_state`,
  `sim/AMM:swap_tokens_for_exact_tokens_from` — each ~2.2–2.6s of node calls.
- `pxe/proveTx` — 2s of node calls inline with witgen (witnesses), interleaved
  with ~14s of pure WASM proving.

**Observation**: inside the ~25s `simulate+prove` window, roughly 10–13s is
sequential network round-trips. With the proxy serving stale-but-fresh-enough
results from cache, this collapses to local-DB reads.

---

## 2. Cacheability classification

Categorising every method PXE calls on the node, by stability:

### 2.1 Block-anchored, indefinitely stable (cache key includes `anchorBlockHash`)

Once written, valid for the lifetime of the anchored block. Invalidated only by
reorg of that block.

- `getPrivateLogsByTags(tags, page, referenceBlock)` —
  [aztec-node.ts:369](../../../aztec-packages/yarn-project/stdlib/src/interfaces/aztec-node.ts#L369);
  node throws if `referenceBlock` was reorged out.
- `getPublicLogsByTagsFromContract(contract, tags, page, referenceBlock)`
- `findLeavesIndexes(blockHash, treeId, leaves)`
- `getNoteHashMembershipWitness(blockNumber, noteHash)`
- `getNullifierMembershipWitness(blockNumber, nullifier)`
- `getLowNullifierMembershipWitness(blockNumber, nullifier)`
- `getPublicDataWitness(blockNumber, leafSlot)`
- `getPublicStorageAt(blockNumber, contract, slot)`
- `getBlockHashMembershipWitness(blockNumber, leafBlockHash)`
- `getL1ToL2MessageMembershipWitness(blockNumber, ...)`
- `getBlock(N)` / `getBlocks(from, limit)` — block content keyed by N is stable
  except on reorg.

### 2.2 Terminal-status cacheable (no block param, but immutable once "deep enough")

- `getTxReceipt(txHash)` — cache forever once `status ∈ {PROVEN, FINALIZED}`;
  short-TTL cache for `PROPOSED`/`CHECKPOINTED` (~1 slot duration, evict on
  reorg); never cache `PENDING`/`DROPPED` as terminal.
- `getTxEffect(txHash)` — cache forever once the tx's block is `proven`
  (since `effect` is derived purely from block content).
- `getTxByHash` / `getTxsByHash` — same as receipt: cache once mined.

### 2.3 Tip-dependent (very-short-TTL cache, with reorg invalidation)

- `getL2Tips` / `getChainTips` — TTL ~ slot/2; the proxy already polls this
  in its own background reorg detector, so external callers can read it
  straight from in-memory state with no network call.
- `getBlockNumber` / `getCheckpointNumber` — derive from cached tips.
- `getCurrentMinFees` — TTL ~ 1 slot.
- `getPredictedMinFees` — TTL ~ 1 slot (or until tip changes).
- `getMaxPriorityFees` — TTL ~ 1 slot.

### 2.4 Static (cache forever, key by chain id)

- `getNodeInfo`, `getVersion`, `getChainId`, `getNodeVersion`,
  `getL1ContractAddresses`, `getProtocolContractAddresses`.

### 2.5 Pass-through (no cache)

- `sendTx`, `simulatePublicCalls`, `isValidTx`, `getPendingTxs`,
  `getPendingTxCount`, `isReady`, `getWorldStateSyncStatus`,
  `getValidatorsStats`, `getValidatorStats`, `getEncodedEnr`,
  `getL2ToL1Messages`.

### 2.6 Contract artifact data (effectively static)

- `getContractClass(id)` — immutable once a class is registered on-chain.
- `getContract(address)` — immutable once an instance is registered. Both
  cache forever.

---

## 3. Reorg invariant and invalidation

### 3.1 What PXE does today

PXE syncs **on demand**, not on a wall-clock timer:
[BlockSynchronizer.sync()](../../../aztec-packages/yarn-project/pxe/src/block_synchronizer/block_synchronizer.ts#L160)
is called at the top of every public entry point —
[simulateTx (pxe.ts:1003)](../../../aztec-packages/yarn-project/pxe/src/pxe.ts#L1003),
[proveTx (pxe.ts:798)](../../../aztec-packages/yarn-project/pxe/src/pxe.ts#L798),
[executeUtility (pxe.ts:1140)](../../../aztec-packages/yarn-project/pxe/src/pxe.ts#L1140),
[getSyncedBlockHeader (pxe.ts:1215)](../../../aztec-packages/yarn-project/pxe/src/pxe.ts#L1215),
[profileTx (pxe.ts:895)](../../../aztec-packages/yarn-project/pxe/src/pxe.ts#L895),
[updateContract (pxe.ts:747)](../../../aztec-packages/yarn-project/pxe/src/pxe.ts#L747).
Each `sync()` triggers the `L2BlockStream` once via `RunningPromise.trigger()`
(the stream is constructed in **manually-triggered** mode — see the explicit
comment at [l2_block_stream.ts:36-39](../../../aztec-packages/yarn-project/stdlib/src/block/l2_block_stream/l2_block_stream.ts#L36)).

The stream's `work()` ([l2_block_stream.ts:67](../../../aztec-packages/yarn-project/stdlib/src/block/l2_block_stream/l2_block_stream.ts#L67)) does
exactly:

1. `node.getL2Tips()` — read source's current proposed/proven/finalized.
2. While `localTips.proposed.hash !== sourceHash(N)`, decrement N (walk back
   via `node.getBlockData(N)` calls) until a common ancestor is found.
3. Emit `chain-pruned` if walked back, then `blocks-added` / `chain-proven` /
   `chain-finalized` as appropriate.

PXE then handles `chain-pruned` at
[block_synchronizer.ts:105](../../../aztec-packages/yarn-project/pxe/src/block_synchronizer/block_synchronizer.ts#L105):
roll back notes, private events, set new anchor header.

`skipFinalized: true` means finalized blocks are never re-fetched —
**reorgs cannot cross the finalized line**.

### 3.2 Proxy's approach — sniff, don't poll

The proxy **does not** run its own `L2BlockStream`. Instead it observes every
RPC PXE makes through it. PXE's on-demand sync already drives all the signal
the proxy needs:

- `node.getL2Tips()` — sniff response, learn current `proposed`/`proven`/`finalized`.
- `node.getBlockData({ number: N })` — sniff response, learn `hash(N)`.
- `node.getBlocks({ from, limit })` — sniff each returned block's `(N, hash)`.

The proxy maintains a small in-memory ring keyed by `blockNumber`:

```ts
type Tip = { proposed: { N, hash }, proven: { N, hash }, finalized: { N, hash } };
ring   : Map<number, { hash, seenAt }>   // recent (N, hash) observations
tip    : Tip | undefined                 // last seen tips
```

**On every sniff** of `getL2Tips` / `getBlockData` / `getBlocks`:

1. For each `(N, newHash)` returned, compare to `ring[N]`.
2. If `ring[N].hash !== newHash` → **reorg observed at block N**. Walk
   `ring`: every entry with `M ≥ N` is now invalid. Evict every cache entry
   whose `anchorBlockNumber ≥ N`. Evict every `getTxReceipt`/`getTxEffect`
   entry whose `blockNumber ≥ N`.
3. If `tip.proven.N` advanced → promote cached `speculative` entries with
   `anchorBlockNumber ≤ new proven.N` to `permanent`.
4. Update `ring[N] = (newHash, now)`, refresh `tip`.

This makes the proxy a **passive observer** of PXE's reorg detection. The
proxy invalidates *during the same `sync()` call* that drives PXE's own
invalidation — no race window where one side has fresher state than the other.

Two-tier in-memory layout:

```
permanent   : Map<key, value>                                  // blocks ≤ proven
speculative : Map<key, { value, anchorBlockNumber, anchorHash }> // blocks > proven
```

### 3.3 What about cache hits between syncs?

Between two PXE `sync()` calls, the proxy's ring is frozen. A cache lookup
returns whatever was cached at last sync. Two failure modes to consider:

**Failure A** — the prefetcher (Phase 2, §4.2) queries the upstream between
PXE syncs and observes a reorg.

The prefetcher's call goes through the same proxy code path; its `getL2Tips`
intercept runs the same eviction logic. So a prefetcher cycle is itself a
sync trigger.

**Failure B** — long gap between PXE syncs; a reorg happens that we never
observe.

If PXE doesn't sync, no cache lookups happen either (PXE doesn't run
oracles outside of `simulateTx`/`proveTx`/`executeUtility`, all of which
sync first). So the stale ring is never consulted in anger. The next PXE
entry point starts with `sync()`, which immediately reconciles.

**Failure C** — PXE-driven sync detects no reorg, but a tag-anchored query
turns out to ask about a block that *was* reorged out at some earlier point
the proxy didn't observe.

Defense in depth: every cache hit on a block-anchored entry first checks
`ring[anchorBlockNumber].hash === entry.anchorHash`. If the ring has a
different hash (because we walked back through that height during walk-back
of a later reorg), the entry is treated as a miss and falls through to
upstream — which itself will throw `block-not-found` if the anchor is gone.

So the proxy's correctness depends on a single invariant: **the cached
`anchorHash` must match the ring's `hash` at that `blockNumber` at the
moment of hit**. Eviction is opportunistic-on-sniff; per-hit validation is
the safety net.

### 3.4 Bonus: the proxy never adds RPC traffic

A polling stream would generate ~1 small RPC per second per browser tab.
The sniff design generates **zero** extra RPCs in steady state. Every
intercepted call was going to happen anyway. The proxy is strictly
RPC-reducing.

---

## 4. Wallet-knowledge superpowers

These are the parts unique to running inside the wallet, beyond plain pass-through caching.

### 4.1 Priming via existing wallet operations — no new public API

The proxy's hint set is **never** exposed on the wallet's public interface.
There is no `primeNodeProxy()` or `kickNodeProxy()` method. Instead, the
embedded wallet overrides four existing operations and feeds the proxy from
inside each — invisible to the wallet's consumers.

| Wallet operation                                              | Hint produced                                |
| ------------------------------------------------------------- | -------------------------------------------- |
| [requestCapabilities(manifest)](../../../aztec-packages/yarn-project/aztec.js/src/wallet/wallet.ts#L289) | Add every `contracts[*].contracts: AztecAddress[]` from the manifest as recipients. Also seed senders from the wallet's already-registered accounts. |
| [registerContract(instance, artifact, secret)](../../../aztec-packages/yarn-project/aztec.js/src/wallet/wallet.ts#L270) | Add `instance.address` as recipient.        |
| [registerSender(address, alias?)](../../../aztec-packages/yarn-project/aztec.js/src/wallet/wallet.ts#L267) | Add `address` as sender (counterparty whose notes we expect). |
| [createAccountInternal(type, secret, salt, signingKey)](../src/embedded-wallet.ts#L254) (already overridden in this package) | Add the new account's address as sender (self).  |

Each override calls the proxy's *internal-only*
`proxy.addSender(addr)` / `proxy.addRecipient(addr)` methods after the base
operation succeeds. These methods live on the proxy instance the wallet holds;
they are not part of `AztecNode` and not on `EmbeddedWallet`'s prototype, so
they cannot leak into the wallet's RPC surface.

```ts
// inside packages/embedded-wallet/src/embedded-wallet.ts

override async requestCapabilities(manifest: AppCapabilities) {
  const granted = await super.requestCapabilities(manifest);
  for (const cap of manifest.capabilities) {
    if (cap.type === 'contracts' && Array.isArray(cap.contracts)) {
      for (const addr of cap.contracts) this.#proxy.addRecipient(addr);
    }
  }
  for (const a of await this.pxe.getRegisteredAccounts()) {
    this.#proxy.addSender(a.address);
  }
  return granted;
}

override async registerContract(instance, artifact?, secretKey?) {
  const out = await super.registerContract(instance, artifact, secretKey);
  this.#proxy.addRecipient(instance.address);
  return out;
}

override async registerSender(address, alias?) {
  const out = await super.registerSender(address, alias);
  this.#proxy.addSender(address);
  return out;
}

protected override async createAccountInternal(type, secret, salt, signingKey) {
  const manager = await super.createAccountInternal(type, secret, salt, signingKey);
  this.#proxy.addSender(manager.getAddress());
  return manager;
}
```

The proxy holds an internal `Set<AztecAddress>` for senders and another for
recipients. Mutations debounce a single background prefetch cycle (~150ms
debounce) — there is no wall-clock timer and no UI-driven kick. The hint set
changes only when the wallet has *just done something meaningful*, which is
exactly when prefetching pays.

### 4.2 What "manifest priming" achieves

When the swap app calls `wallet.requestCapabilities(createGoSwapCapabilities(...))`
([OnboardingModal.tsx:200](../../../apps/swap/src/components/OnboardingModal.tsx#L200)):

- The manifest declares all swap-relevant contracts: token A, token B, AMM,
  FPC, etc. ([apps/swap/src/config/capabilities.ts:27](../../../apps/swap/src/config/capabilities.ts#L27)).
- All of those land in the proxy's recipient set in one shot.
- The wallet's existing accounts (loaded earlier in `EmbeddedWallet.create()`)
  land in the sender set.
- A single debounced prefetch cycle warms the cache for the full
  sender×recipient grid before the user has clicked "Swap" once.

`requestCapabilities` fires on **every** app connection (not only on initial
onboarding), so the warm-up runs reliably each session start.

### 4.3 Background sender-sync prefetcher — rederive, don't peek

The proxy **does not** read PXE's `senderTaggingStore` or any other PXE
internal state. Instead it rederives everything it needs from public stdlib
crypto and from RPC traffic it has already observed. The wallet provides one
small callback (`getKeysFor(sender)`) so the proxy can access the keystore
material it needs — exactly what `ExtendedDirectionalAppTaggingSecret.compute`
requires.

When the hint set mutates, a debounced cycle runs:

```ts
async function prefetchCycle(self: CachingNodeProxy) {
  const anchor = sniffer.latestAnchorHash();   // from §3.2, sniffed from PXE traffic
  if (!anchor) return;                         // nothing to anchor against yet

  for (const sender of senders) for (const recipient of recipients) {
    const { completeAddress, ivsk } = await getKeysFor(sender);

    // For each app (= contract) the user will plausibly touch, derive the secret:
    for (const app of recipients) {
      const extSecret = await ExtendedDirectionalAppTaggingSecret.compute(
        completeAddress, ivsk, recipient, app, recipient,
      );
      if (!extSecret) continue;

      // Derive tags for the first window of indexes.
      const siloedTags = await Promise.all(
        range(0, UNFINALIZED_TAGGING_INDEXES_WINDOW_LEN).map(i =>
          SiloedTag.compute({ extendedSecret: extSecret, index: i })
        ),
      );

      // Issue through ourselves so the per-tag cache layer (§3.5) populates.
      const logsPerTag = await self.getPrivateLogsByTags(siloedTags, 0, anchor);

      // Pre-warm receipts for any tx hashes we surfaced — caches.
      const seenTxHashes = unique(logsPerTag.flat().map(l => l.txHash));
      await Promise.all(seenTxHashes.map(h => self.getTxReceipt(h)));
    }
  }
}
```

All the imports come from `@aztec/stdlib/logs`:
[`ExtendedDirectionalAppTaggingSecret`](../../../aztec-packages/yarn-project/stdlib/src/logs/extended_directional_app_tagging_secret.ts#L25),
[`SiloedTag`](../../../aztec-packages/yarn-project/stdlib/src/logs/siloed_tag.ts#L15),
[`Tag`](../../../aztec-packages/yarn-project/stdlib/src/logs/tag.ts).
The constant `UNFINALIZED_TAGGING_INDEXES_WINDOW_LEN` is small (100) and
stable; we either re-export it from `@aztec/pxe/tagging` (already barrelled at
[tagging/index.ts:19](../../../aztec-packages/yarn-project/pxe/src/tagging/index.ts#L19))
or hardcode it (it's also baked into Noir-side asserts).

When PXE later runs sender-sync inline during simulation, the per-tag cache
(§3.5) serves the underlying tag lookups regardless of how PXE batches them.
The PXE store still records the pending-index ranges itself — we don't
double-write, don't even read.

### 4.4 Per-tag cache decomposition — why this works without store access

A naive proxy would cache `getPrivateLogsByTags(tags, page, anchor)` by the
whole `tags` array. That would miss whenever the proxy's prefetch
composition differs from PXE's inline composition — which it always will,
because PXE picks tag ranges from `senderTaggingStore.lastFinalizedIndex + 1`
and we have no idea what that index is.

The proxy instead **decomposes batch responses into per-element entries**:

| Method                              | Decomposed cache key                              |
| ----------------------------------- | ------------------------------------------------- |
| `getPrivateLogsByTags(tags, p, a)`  | One entry per `(siloedTag, page, anchor)`         |
| `getPublicLogsByTagsFromContract(c, tags, p, a)` | One entry per `(contract, tag, page, anchor)` |
| `findLeavesIndexes(a, treeId, leaves)` | One entry per `(treeId, leaf, anchor)`        |

Intercept logic for `getPrivateLogsByTags`:

1. Receive `(tags, page, anchor)`.
2. For each `siloedTag`, look up `(siloedTag, page, anchor)` in cache.
3. Build `missing = tags.filter(t => !cache.has(...))`.
4. If `missing.length > 0`, issue a single batched upstream call with only
   `missing`; on response, store each `missing[i] → response[i]` per-tag.
5. Assemble the per-tag result array in the original `tags` order and
   return.

This is the key that makes the rederive approach actually deliver. The
prefetcher can scan window `[0, 100)` while PXE asks for `[57, 157)`; the
57 overlapping tags hit cache and only the disjoint 57 fall through.

Inflight dedup (§4.6) applies at the same per-element granularity.

### 4.5 Own-tx prefetch — also from existing operations

When the wallet's existing `sendTx` flow submits a transaction, the proxy
sees the `node.sendTx` RPC pass through it. On that sniff:

- Pre-warm `getTxReceipt(txHash)` polling in the background, so the next time
  PXE asks (e.g. during the next simulation's sender-sync) the answer is
  cached.
- Promote the entry to `permanent` as soon as the upstream returns
  `status >= PROVEN`.
- Optionally pre-warm `getTxEffect(txHash)` after the receipt is mined.

No wallet-side hook needed: `sendTx` already routes through the proxy.

### 4.6 Inflight dedup

A trivial but high-impact win: while one in-flight call to e.g.
`getPrivateLogsByTags(tagsA, page=0, blockX)` is outstanding, a second
identical call from another `executeUtility` shares the promise. Today PXE
runs the same scan inside multiple `sim/Foo:sync_state` records — those
identical queries can collapse into one round-trip when the proxy dedups.

### 4.7 Multi-device caveat — handled

The user may interact via another browser; tagged logs can arrive from
sources the wallet doesn't know about. The proxy never *predicts* logs from
its own send-history alone; the prefetcher always asks the node. So we
remain correct even if other devices are also using the account; we just lose
some prefetch benefit when an unknown peer sends notes.

---

## 5. Architecture

```
                    ┌────────────────────────────────┐
                    │     CachingNodeProxy           │
                    │  (implements AztecNode via     │
                    │   JS Proxy → upstream client)  │
                    │                                │
   ┌────────────┐   │  ┌──────────────────────────┐  │   ┌──────────────┐
   │            │   │  │  cache layer             │  │   │              │
   │   PXE      ├──►│  │  permanent  (≤ proven)   │  │◄──┤  upstream    │
   │ (unchanged)│   │  │  speculative(> proven)   │  │   │  AztecNode   │
   │            │   │  └──────────────────────────┘  │   │  (http rpc)  │
   └────┬───────┘   │  ┌──────────────────────────┐  │   └──────────────┘
        │           │  │  reorg sniffer           │  │
        │           │  │  (passive: watches        │  │
        │           │  │   getL2Tips / getBlock(s)│  │
        │           │  │   responses; maintains   │  │
        │           │  │   (N→hash) ring + tip)   │  │
        │           │  └──────────────────────────┘  │
        │           │  ┌──────────────────────────┐  │
   ┌────▼───────┐   │  │  prefetcher              │  │
   │  Wallet    ├ ─►│  │  (per-secret background  │  │
   │  overrides │   │  │   sender-sync replay)    │  │
   │  call      │   │  └──────────────────────────┘  │
   │  addSender │   │  ┌──────────────────────────┐  │
   │  /addRcpt  │   │  │  inflight dedup map      │  │
   │  internally│   │  └──────────────────────────┘  │
   └────────────┘   └────────────────────────────────┘

   Hook points (all are existing operations — no new public methods):
     wallet.requestCapabilities(manifest) → bulk addRecipient + seed addSender
     wallet.registerContract(...)          → addRecipient(instance.address)
     wallet.registerSender(...)            → addSender(address)
     wallet.createAccountInternal(...)     → addSender(newAccount.address)
     node.sendTx sniff (already through proxy) → pre-warm getTxReceipt
```

Injection: `EmbeddedWallet.create(node)` already accepts an `AztecNode`
instance ([embedded-wallet.ts:152](../src/embedded-wallet.ts#L152)). The wallet
constructs the proxy and passes it through.

---

## 6. Implementation plan

### 6.1 Phase 1 — Pure caching proxy (no wallet hints)

Goal: deliver the easy 30–50% win on simulation-time RPC waits with a
minimal change set. Risk: low (purely additive).

Files (new, in `packages/embedded-wallet/src/node-proxy/`):

1. `caching-node-proxy.ts` — `CachingNodeProxy implements AztecNode`, built on a
   JS `Proxy` over an upstream `AztecNode` (mirror of `BenchmarkedNode`'s
   pattern at
   [benchmarked_node.ts:23](../../../aztec-packages/yarn-project/pxe/src/contract_function_simulator/benchmarked_node.ts#L23)).
   Implements **per-element decomposition** (§4.4) for `getPrivateLogsByTags`,
   `getPublicLogsByTagsFromContract`, and `findLeavesIndexes`: split incoming
   batches against the per-element cache, send only the misses upstream,
   reassemble responses in the requested order.
2. `cache.ts` — Two-tier `Map`-based cache with explicit eviction.
3. `reorg-sniffer.ts` — Passive observer. Maintains a `(N → hash)` ring and a
   `tip` (latest `proposed`/`proven`/`finalized` seen). Updated by every
   sniffed `getL2Tips` / `getBlockData` / `getBlocks` response. Exposes
   `notePinnedBlock(N, hash)` (called by the caching layer for every observed
   `(N, hash)` pair), `latestTip()`, and `isAnchorStillValid(N, hash)` used by
   per-hit validation. Runs **no** poll loop of its own.
4. `keys.ts` — `cacheKey(method, args)` — stable JSON for `Fr`/`AztecAddress`
   via their `toString()`.
5. `inflight.ts` — `inflight<K, V>(key, fn)` → shared `Promise<V>`. Also at
   per-element granularity for decomposed methods.
6. `index.ts` — exports.

Wired in `embedded-wallet.ts` `create()`:

```ts
const upstream = typeof nodeOrUrl === "string" ? createAztecNodeClient(nodeOrUrl) : nodeOrUrl;
const node = createCachingNodeProxy(upstream);    // ← new
// ... use `node` everywhere previously used `upstream`
```

Cache policies — only the high-value methods (others pass through):

| Method                              | Tier        | Key                                   | Granularity      |
| ----------------------------------- | ----------- | ------------------------------------- | ---------------- |
| `getPrivateLogsByTags`              | block       | `(siloedTag, page, refBlock)`         | per-tag          |
| `getPublicLogsByTagsFromContract`   | block       | `(contract, tag, page, refBlock)`     | per-tag          |
| `findLeavesIndexes`                 | block       | `(blockHash, treeId, leaf)`           | per-leaf         |
| `getNullifierMembershipWitness`     | block       | `(blockNum, nullifier)`               | per-arg (single) |
| `getNoteHashMembershipWitness`      | block       | `(blockNum, noteHash)`                | per-arg          |
| `getLowNullifierMembershipWitness`  | block       | `(blockNum, nullifier)`               | per-arg          |
| `getPublicDataWitness`              | block       | `(blockNum, leafSlot)`                | per-arg          |
| `getPublicStorageAt`                | block       | `(blockNum, contract, slot)`          | per-arg          |
| `getBlock` / `getBlocks`            | block       | `(blockNum, ...)`                     | per-block        |
| `getTxReceipt`                      | by-status   | `txHash` (no cache below PROVEN)      | per-arg          |
| `getTxEffect`                       | by-status   | `txHash`                              | per-arg          |
| `getContract` / `getContractClass`  | permanent   | `address` / `classId`                 | per-arg          |
| `getNodeInfo` / `getChainId` / ...  | permanent   | none                                  | per-call         |
| `getL2Tips`                         | tip-cache   | none, TTL 500ms                       | per-call         |
| `getCurrentMinFees`                 | tip-cache   | none, TTL 1 slot                      | per-call         |
| everything else                     | passthrough |                                       |                  |

Per-tag / per-leaf granularity means batch responses are split into
per-element cache entries on store, and incoming batches are split against
the cache on lookup — the proxy assembles a partial response from cache and
queries the upstream only for the misses (§4.4). This is what lets the
rederive prefetcher (§4.3) hit cache regardless of how PXE later groups its
tag/leaf queries.

Inflight dedup applies to **every** cacheable method.

#### Expected gains (phase 1 alone)

Conservative — purely caching, no prefetch:

- `executeUtility` repeated calls inside one tx flow (token balance, fee
  preview, etc.) — many hit the same `(slot, blockNum)` → estimate -50% of the
  4.4s `pxe/executeUtility` RPC time → **~2s saved**.
- Repeated `findLeavesIndexes`, `getPublicStorageAt`, `getPrivateLogsByTags`
  across the simulation phases (Token:sync_state runs once per token; AMM and
  SubscriptionFPC each re-sync overlapping state) → **~3s saved**.
- Inflight dedup of the 8 `getTxReceipt` inside `SubscriptionFPC:subscribe`
  + 4 in `proveTx` — many overlap → **~1s saved**.

→ ~6s off the ~25s `simulate+prove` window, ~25% speedup, on the easy path.

### 6.2 Phase 2 — Background prefetcher (no new public surface)

No new methods on `EmbeddedWallet`. Priming is driven entirely from
overrides of existing operations (§4.1). The proxy gains internal-only
methods that the wallet calls from inside those overrides:

```ts
// in packages/embedded-wallet/src/node-proxy/caching-node-proxy.ts
class CachingNodeProxy /* implements AztecNode */ {
  // ... AztecNode methods (the public surface, unchanged) ...

  // Internal-only — not on AztecNode, not on EmbeddedWallet.
  addSender(addr: AztecAddress): void { /* set, debounce-schedule cycle */ }
  addRecipient(addr: AztecAddress): void { /* set, debounce-schedule cycle */ }
  removeSender(addr: AztecAddress): void { ... }
  removeRecipient(addr: AztecAddress): void { ... }
}
```

The four `EmbeddedWallet` overrides shown in §4.1 fire `addSender` /
`addRecipient` at the right moments. None of them changes the wallet's
public interface — each just adds a side effect to an operation that
already existed. Consumers (apps, the swap UI, e2e tests) see no
difference.

Additional files (in `packages/embedded-wallet/src/node-proxy/`):

7. `prefetcher.ts` — Owns the sender/recipient sets, the debounce scheduler,
   and the cycle body shown in §4.3. Calls into the proxy through its
   normal AztecNode surface so per-element caching populates uniformly.
8. `tag-derivation.ts` — Thin wrapper around stdlib's
   `ExtendedDirectionalAppTaggingSecret.compute` and `SiloedTag.compute`,
   so the prefetcher code stays readable. Pure function, no state.

The prefetcher rederives — see §4.3 for the full body. It depends only on
`@aztec/stdlib/logs` (`ExtendedDirectionalAppTaggingSecret`, `SiloedTag`,
`Tag`) and on a wallet-supplied `getKeysFor(sender)` callback. No PXE
internals.

Constructor wiring in `embedded-wallet.ts` `create()`:

```ts
const upstream = typeof nodeOrUrl === 'string' ? createAztecNodeClient(nodeOrUrl) : nodeOrUrl;

const proxy = createCachingNodeProxy(upstream, {
  // Wallet-supplied: returns the keystore material needed for tag derivation.
  // This is keystore-only — no PXE storage access.
  getKeysFor: async (sender) => ({
    completeAddress: await this.#keystore.getCompleteAddress(sender),
    ivsk: await this.#keystore.getMasterIncomingViewingSecretKey(sender),
  }),
});

const wallet = await super.create<T>(proxy, finalOptions);
// proxy now intercepts every PXE→node call and sniffs tips off the
// `sync()` traffic PXE generates at every entry point (§3).
```

The prefetcher does **not** write to PXE's stores — it only warms the proxy's
cache. PXE then reads through the cache during inline simulation and skips
the network. The proxy never reads PXE's tagging store, note store, anchor
block store, or any other internal state. Everything it needs is either
rederived from stdlib crypto or sniffed from RPC traffic.

Trigger points (all already exist in the wallet — we just hook them):

| Event sniffed                        | Action                                                   |
| ------------------------------------ | -------------------------------------------------------- |
| `requestCapabilities(manifest)` override | Bulk-add manifest contracts as recipients, seed senders from PXE's account list, debounce-schedule a prefetch cycle. |
| `registerContract(...)` override     | `addRecipient(instance.address)`.                        |
| `registerSender(...)` override       | `addSender(address)`.                                    |
| `createAccountInternal(...)` override| `addSender(newAccount.address)`.                         |
| `node.sendTx` sniff (in proxy)       | Pre-warm `getTxReceipt(returnedTxHash)`.                 |

#### Expected gains (phase 2)

- The `getTxReceipt` × 14 inside `sim/SubscriptionFPC:subscribe` —
  predominantly pending-tx receipt checks the wallet can warm in background →
  near-zero in-line cost → **~2s saved**.
- The `getPrivateLogsByTags` × 8 inside `Token:sync_state` & friends — same →
  **~1.5s saved**.

→ Total ~9–10s off the simulate+prove window, ~35–40% end-to-end on this phase.

### 6.3 Phase 3 — Persistence to OPFS (cold-start)

Phase 1+2 are in-memory only. To speed up *cold* boots (first simulation after
opening the app), persist the `permanent` tier to OPFS (the embedded wallet
already uses `AztecSQLiteOPFSStore`). Schema: one KV table keyed by
`cache_key`. Eviction on quota: LRU.

The `speculative` tier stays in memory; persisting it across reloads is risky
(we'd need to also persist the reorg watcher's local tips ring).

### 6.4 Phase 4 — Upstream (optional, after we've validated locally)

One upstream patch to make this work everywhere, not just embedded wallets:

- A thin `NodeCacheAdapter` interface in `@aztec/aztec.js/node` that
  `createAztecNodeClient` accepts — moves the proxy out of the embedded
  wallet so any wallet can plug it in.

Tag-derivation crypto is already public in `@aztec/stdlib/logs`
(`ExtendedDirectionalAppTaggingSecret.compute`, `SiloedTag.compute`,
`Tag.compute`), so the rederive prefetcher needs no upstream change.

Not required for the embedded wallet to ship — this just generalizes the
caching surface.

---

## 7. Post-`sendTx` polling tail (out of scope but easy)

The 42-receipt, 52-second polling loop after `sendTx` returns is in
[aztec.js/.../waitForTx](../../../aztec-packages/yarn-project/aztec.js/src/node/wait_for_tx.ts) (approximate path — verify).
It polls every ~1s. Two trivial improvements once the proxy exists:

- The proxy can serve the polling out of its own background pump (it's already
  pre-warming via §4.4). PXE/wallet's outer loop becomes a memoized read.
- Adaptive backoff: poll fast for the first slot (1s) then slow down.

This is independent of `simulateTx`/`proveTx` perf and can land as a separate
patch.

---

## 8. Testing strategy

### 8.1 Unit

- `cache.ts`: tier transitions, LRU bounds, eviction-on-prune.
- `reorg-sniffer.ts`: feed it canned `getL2Tips` / `getBlockData` sequences,
  assert ring updates, reorg detection on hash divergence at a given height,
  and `proven`/`finalized` advance triggers permanent-promotion. Important
  case: ring grows monotonically forward, then a sniffed `getBlockData(N)`
  returns a different hash than the ring stored — assert all entries
  ≥ N are invalidated.
- `caching-node-proxy.ts`: a fake upstream `AztecNode` that returns canned
  responses; assert (a) cache hit after first call, (b) no cache hit across
  different `referenceBlock`, (c) inflight dedup collapses concurrent calls,
  (d) per-hit `isAnchorStillValid` check rejects a cached entry whose stored
  `anchorHash` differs from the sniffer's current `ring[N]`.

### 8.2 Integration (against a local sandbox)

- Two consecutive `simulate` of the same transfer — assert second has zero
  network calls for cached methods.
- Reorg test: induce a reorg on the sandbox; perform a PXE `simulate` (which
  triggers `sync()` and routes through the proxy). Assert the proxy's sniffer
  observed the reorg (via the same `getL2Tips`+walk-back PXE drives) and
  evicted matching entries; subsequent cache lookups for the reorged-out
  anchor miss and either fall through to upstream (which throws
  `block-not-found`) or return the new canonical data the same `sync()` just
  produced.
- Multi-secret prefetch test: hint two senders × three recipients, observe
  that subsequent `simulate` makes no `getPrivateLogsByTags`/`getTxReceipt`
  network calls.

### 8.3 E2E

The existing `apps/swap` E2E flow with the proxy enabled. Compare profile
shape: expect the `node/getPrivateLogsByTags` and `node/getTxReceipt` count
inside `sim/*` records to drop ~80–100%.

---

## 9. Open questions / follow-ups

- **`getTxReceipt` short-TTL window**: how aggressively can we cache PROPOSED
  receipts? Probably ≤ 1 slot before reorg risk dominates. Empirically tune
  against testnet slot duration.
- **Prefetcher cadence vs PXE's on-demand model**: the Phase 2 prefetcher
  fires on a short debounce only when the hint set mutates (override of
  `requestCapabilities` / `registerContract` / `registerSender` /
  `createAccountInternal`), never wall-clock. Each prefetch cycle itself
  goes through the proxy, so any tip changes the prefetcher observes feed
  the reorg sniffer just like PXE's syncs do. Verify on a long idle (wallet
  open, no activity, chain reorgs) that we don't leak stale cache — the
  per-hit `isAnchorStillValid` check is the backstop.
- **Coupling of proxy and wallet**: the proxy stays AztecNode-shaped on its
  public surface; its `addSender`/`addRecipient` are wallet-internal. For a
  non-embedded wallet, the same hooks can be applied by overriding the same
  base methods, or simply skipped — the proxy still works as a pure cache
  without any hints. Hint priming is a strict upgrade, not a dependency.
- **`executeUtility` RPC volume (4.4s)** is mostly `getPublicStorageAt` + a
  little tag scanning. Worth profiling separately — fee estimation may have
  its own hot path independent of the swap simulation.
