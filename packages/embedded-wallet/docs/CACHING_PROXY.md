# Caching node proxy + tag warmer — design report

This is the distilled report of what the caching layer between PXE and
the Aztec node actually does, what survived the iterations, and what
was thrown out. Read this if you're trying to understand why something
was implemented this way; everything older in this directory is
superseded.

## What it solves

PXE makes hundreds of JSON-RPC calls to the Aztec node per swap on
testnet. Each call costs ~140ms (network round-trip + node-side
processing). A typical onboarding + swap can issue 200+ calls; at
sequential speeds that's tens of seconds of pure wait.

Three categories of calls dominate:

1. **`getPrivateLogsByTags`** — PXE's tagged-log scan. Issued by
   `syncTaggedPrivateLogs` (recipient direction) and the simulator
   when contracts call `getPendingTaggedLogsV2(scope)`. Per call,
   PXE batches up to 100 tags spanning multiple `(sender, recipient,
   app, index)` tuples.

2. **`getTxReceipt` / `getTxEffect`** — polled repeatedly by
   `get_status_change_of_pending` during sender-sync. The same tx
   hashes are queried over and over during a single simulator run.

3. **Witnesses + `getPublicStorageAt`** — anchored-to-block-hash
   reads issued by the kernel oracle during prove. Each is unique
   per `(slot, blockHash)` so caching only helps within-anchor
   duplicates.

## The four wins

### 1. Block-bounded cache for `getPrivateLogsByTags` page 0

[block-bounded-cache.ts](../src/node-proxy/block-bounded-cache.ts)

The node's `getPrivateLogsByTags(tags, page=0, refBlock)` is
**monotonic in `refBlock.number`**: a query at block M returns a
superset of the same query at any block ≤ M. PXE also re-filters
client-side by `log.blockNumber ≤ anchor`.

So we cache one entry per tag value with `{value, scannedAtBlock}`
and serve any query at anchor ≤ scannedAtBlock by filtering. Without
this, every L2 tip advance between the warm and PXE's sync (every
~36s on testnet) caused full cache misses.

Page > 0 falls back to anchor-keyed caching because we can't
reconstruct what was skipped on lower pages.

### 2. Deterministic tag warm-up

[tag-derivation.ts](../src/node-proxy/tag-derivation.ts) +
[tag-warmer.ts](../src/node-proxy/tag-warmer.ts)

PXE's tag scan iterates `senders ∪ accounts × { recipient = scope,
app = calling_contract }` over indices `(highestAged, highestFinalized
+ 20]`. The tag values are deterministic from those inputs via the
Diffie-Hellman formula in `ExtendedDirectionalAppTaggingSecret.compute`.
Critically, the DH is **symmetric**: holding the recipient's ivsk
lets the wallet compute the same tag value the sender would emit.

The warmer:
- Reads `pxe.getRegisteredAccounts()`, `pxe.getSenders()`,
  `pxe.getContracts()` to get PXE's actual iteration set.
- For each `(recipient, sender, app)` triple, computes 100 tags
  starting at index 0.
- Fires one parallel `getPrivateLogsByTags` per triple (per-triple
  batch, all triples concurrent).
- Adaptively extends each triple's scan if activity exists in the
  upper PXE_WINDOW_LEN (20) indices, mirroring PXE's own "advance
  until empty" exit condition. Handles drift from prior on-chain
  activity (another device, counterparty actions).

Live measurement: 76–100% hit rate for `getPrivateLogsByTags`
during PXE's actual sync calls.

### 3. Tx hash harvest + receipt/effect pre-warm

[tag-warmer.ts](../src/node-proxy/tag-warmer.ts) "phase E"

Every log entry returned by `getPrivateLogsByTags` carries a
`txHash`. PXE later iterates those exact hashes in
`sender_sync`'s `get_status_change_of_pending` (a `getTxReceipt`
call), and the simulator follows with `getTxEffect` lookups for
the same hashes. So after the tag warm completes we:

- Collect the union of every txHash that appeared in any warmed
  log entry.
- Use `TxHash.fromString()` (not a `{toString()}` stub — the node
  rejects those over JSON-RPC).
- Fire all `getTxReceipt` + `getTxEffect` calls in parallel via
  `Promise.allSettled`.

Live measurement: 94–100% hit rate on receipts + effects during
the swap. ~15 seconds of cumulative network time eliminated per
swap.

### 4. TTL caches for mutable but slow-changing data

[caching-node-proxy.ts](../src/node-proxy/caching-node-proxy.ts)
`TX_RECEIPT_TTL_MS`, `TX_EFFECT_TTL_MS`, `PUBLIC_STORAGE_TTL_MS`

For data we can't permanently cache:

- **`getTxReceipt`** (30s TTL): status changes propagate within
  ~one L2 block (~36s on testnet). 30s collapses poll storms
  inside one simulator run without making the UI noticeably stale.
- **`getTxEffect`** (120s TTL): content-addressed and immutable per
  block. The long TTL only releases on reorg-eviction.
- **`getPublicStorageAt`** (2s TTL): slot values can change per
  block; the short TTL only catches re-reads of the same slot
  within a single sim phase.

Finalized receipts skip the TTL and go straight to the permanent
cache — L1 finality is reorg-safe.

## What got thrown out

This is what we tried and removed because it didn't earn its
complexity:

- **Sequential prefetcher with idle gating.** Couldn't finish a cycle
  before the chain advanced; every sim hit a cold cache anyway.
  Replaced with the batched warm above.
- **Closed-loop observation map** (`tag → (secret, index)` reverse
  map; `noteTagsQueried` etc). Learned PXE's scan window after PXE
  already asked — too late to help. Replaced by computing PXE's
  enumeration directly from `pxe.getRegisteredAccounts/getSenders/
  getContracts`.
- **`simulateTx` / `executeUtility` overrides + `#currentWarmPromise`
  machinery** to make sim wait for in-flight warm. Didn't move the
  hit rate; the warm fires fast enough on `registerContract`
  triggers that races are rare. ~100 lines removed.
- **Warm-vs-PXE call attribution** (`__markNextAsWarm`,
  `warmCalls/warmHits/warmMisses` counters). Useful for one
  diagnostic, but the per-element `el=H/S` line covers the same
  signal without per-call instrumentation.
- **`__nodeProxyDiagMiss` global hook** for full-miss tag samples.
  Useful while debugging the "why 77% not 100%" mystery, removed
  once that was solved.
- **Boot-only e2e variant**. Full swap covers everything boot
  exercised; running both wastes minutes per CI run.
- **`pxe.getRegisteredAccounts` round-trip in `#noteAccountFromContract`**.
  Replaced with `CompleteAddress.fromSecretKeyAndInstance(secret, instance)`
  — pure local derivation, no async.
- **Separate `inflight.ts` module**. The dedup logic is a 10-line
  Map; inlined.

## Files (what's left)

| File | Purpose | Lines |
|---|---|---|
| `node-proxy/caching-node-proxy.ts` | The proxy itself: anchor cache, TTL caches, per-method handlers, reorg eviction | 918 |
| `node-proxy/block-bounded-cache.ts` | Monotonic-by-blockNumber cache for tag responses | 99 |
| `node-proxy/cache.ts` | TwoTierCache: permanent (immutable) + speculative (anchor-keyed) | 90 |
| `node-proxy/reorg-sniffer.ts` | Tip observation + reorg detection by hash divergence | 170 |
| `node-proxy/tag-derivation.ts` | `computeSiloedTagsForWindow(recipient, sender, app, fromIndex, count)` | 63 |
| `node-proxy/tag-warmer.ts` | `warmTags(...)` — enumerate, derive, fetch, harvest txHashes, pre-warm receipts+effects | 402 |
| `node-proxy/keys.ts` | Cache-key builders | 26 |
| `node-proxy-inspector.ts` | Dev-only `window.__nodeProxy.stats()/dump()` + auto-dump | 52 |
| `embedded-wallet.ts` (proxy bits only) | `#accountKeys` map, `warmTagCache()`, `registerContract/Sender` hooks, `createAccountInternal` hook | ~200 of 848 |

Tests: 63/63 unit tests pass. Live testnet swap e2e
([07-testnet-iteration.spec.ts](../../../e2e/tests/07-testnet-iteration.spec.ts))
asserts ≥70% receipt + ≥70% effect hit rate during the swap window.

## Live measurements (testnet, 2026-05-17/18)

```
boot → awaiting_drip: ~16s
click → end-of-sim+prove: ~3.5s (test errors at sendTx due to testnet CORS)
SWAP-ONLY hit rates:
  getPrivateLogsByTags  25% (conflated by warm batches re-firing during swap)
  getTxReceipt          94% (65/69)
  getTxEffect          100% (62/62)
  getPublicStorageAt     0%
swap upstream RPCs: 67 (~9s of network at 140ms/call)
```

The PXE-only tag hit rate during the swap is much higher than the
shown 25% (which counts warm-populating calls as misses). Cumulative
per-element rate across the run: 58% (14131/24126).

## What still hurts

- **`getPublicStorageAt`**: 0% hit rate. Each slot is queried once per
  anchor; no duplicates within the TTL window. Could cache speculatively
  but the slot is genuinely mutable.
- **Witness calls** (`getNullifierMembershipWitness`,
  `getPublicDataWitness`, `getNoteHashMembershipWitness`): low hit
  rate; each leaf/anchor pair is unique.
- **First-sim race**: if the user clicks swap before the warm-up
  completes (rare on testnet — boot takes ~16s, warm completes in
  ~2s), the first sim's tag scans miss cache. We accepted this
  trade-off after removing the `simulateTx` await machinery.
- **L2 tip churn**: when the chain advances between warm and sim,
  the block-bounded cache absorbs it for tag queries. For witness
  calls, no help — those are anchored.
