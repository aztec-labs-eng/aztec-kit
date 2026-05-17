import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { SiloedTag } from "@aztec/stdlib/logs";
import { TxHash } from "@aztec/stdlib/tx";

import type { CachingNodeProxy } from "./caching-node-proxy";
import { computeSiloedTagsForWindow, type RecipientKeyMaterial } from "./tag-derivation";

/**
 * Maximum number of tags carried in a single `getPrivateLogsByTags` RPC
 * batch. Matches PXE's `MAX_RPC_LEN` (`@aztec/stdlib/dest/interfaces/api_limit.js`) —
 * the node enforces this on the wire. We size each per-triple batch to
 * stay at or below this.
 */
const MAX_TAGS_PER_RPC = 100;

/**
 * PXE's tagging-window length, `UNFINALIZED_TAGGING_INDEXES_WINDOW_LEN`
 * (`@aztec/pxe/dest/tagging/constants.js`). PXE scans
 * `(highestFinalizedIndex, highestFinalizedIndex + WINDOW_LEN]`, so once
 * we've seen activity at index N we need to cover up to N + WINDOW_LEN
 * for the next scan to be a cache hit.
 */
const PXE_WINDOW_LEN = 20;

/**
 * Hard safety cap on indices we'll scan per (sender, recipient, app)
 * triple. PXE would never legitimately drive a single secret's index
 * past this on any realistic wallet, and capping prevents a misbehaving
 * node (or a test) from holding the warm-up open indefinitely. If your
 * production usage ever approaches this, raise it; do not silently let
 * it serialize warm-up rounds forever.
 */
const MAX_INDICES_PER_TRIPLE = 1000;

/**
 * Default size of the first scan window per triple. PXE's actual scan
 * window is `PXE_WINDOW_LEN`; we go wider so a single round-trip covers
 * most realistic drift without follow-up extensions. The warm is
 * adaptive — see {@link warmTags} — so this is just a starting size,
 * not a hard cap.
 */
export const DEFAULT_WARM_WINDOW = 100;

export interface WarmTagsOptions {
  proxy: CachingNodeProxy;
  /**
   * The wallet's own accounts. PXE's `recipient_sync` scans for incoming
   * notes addressed to each of these. Must include `ivsk` (derived from
   * the account secret) and `completeAddress`.
   */
  accounts: RecipientKeyMaterial[];
  /**
   * Counterparty addresses to enumerate as `sender` in the directional
   * secret. PXE's actual scan iterates `senders ∪ accounts`, so callers
   * typically pass `pxe.getSenders()`.
   */
  senders: AztecAddress[];
  /**
   * Contract addresses to enumerate as `app` in the directional secret.
   * Typically `pxe.getContracts()`.
   */
  contracts: AztecAddress[];
  /** Block hash to anchor the upstream fetch against. */
  anchorHash: { toString(): string };
  /** Initial window of indices to pre-fetch per triple. Defaults to {@link DEFAULT_WARM_WINDOW}. */
  windowSize?: number;
  /** Logger; if absent we swallow errors silently. */
  log?: (msg: string, err?: unknown) => void;
}

export interface WarmTagsResult {
  /** Number of (sender, recipient, app) triples enumerated. */
  triples: number;
  /** Total siloed-tag values queried (sums across extension rounds). */
  tagsQueried: number;
  /** Number of upstream batched RPCs issued across all triples + rounds. */
  rpcBatches: number;
  /** Number of triples that returned at least one log somewhere in their scan range. */
  triplesWithHits: number;
  /** Total log entries returned across all queried tags. */
  logsFound: number;
  /** Wall-clock duration of the warm-up. */
  durationMs: number;
  /**
   * Number of triples whose scan triggered at least one adaptive
   * extension (i.e. activity sat within `PXE_WINDOW_LEN` of the upper
   * bound, forcing a follow-up round). Pure observability — useful for
   * spotting drift in production.
   */
  triplesExtended: number;
}

/**
 * One (sender, recipient, app) triple's scan state across rounds.
 */
interface TripleResult {
  batches: number;
  tagsQueried: number;
  logsFound: number;
  hadHits: boolean;
  extended: boolean;
  /**
   * Tx hashes harvested from the log entries returned by this triple's
   * `getPrivateLogsByTags` queries. PXE later iterates these same hashes
   * in `sender_sync`'s `get_status_change_of_pending` (and the
   * `getTxEffect` lookup that follows), so pre-fetching them
   * substantially cuts the per-boot upstream call count.
   */
  txHashes: Set<string>;
}

/**
 * Pre-warm the caching proxy's `getPrivateLogsByTags` cache by deriving
 * every tag PXE will scan and batch-fetching them in parallel, with
 * **adaptive extension** to handle index drift from prior wallet
 * activity on other devices or counterparties.
 *
 * # Why this works
 *
 *   • Tags are deterministic from `(sender, recipient, app, index)` and
 *     a Diffie-Hellman secret. The DH is symmetric: holding the
 *     recipient's ivsk lets the wallet compute the SAME tag value the
 *     sender would emit. We do not need anyone else's keys.
 *   • PXE's `#getSecretsForSenders` (`log_service.js:62`) iterates
 *     `senders ∪ accounts` × `{ recipient = scope, app = calling_contract }`
 *     over `(highestFinalizedIndex, highestFinalizedIndex + WINDOW_LEN]`.
 *     Pre-computing every index up through the highest activity, PLUS a
 *     PXE_WINDOW_LEN-wide empty tail, covers every window PXE could
 *     possibly land on.
 *   • The proxy's block-bounded cache for `getPrivateLogsByTags` page 0
 *     keeps these entries usable across L2 tip advances: an entry
 *     scanned at block M serves any query at anchor ≤ M.
 *
 * # Adaptive extension (the drift fix)
 *
 * A naive fixed `[0, K)` warm misses PXE's scan when the index has
 * drifted: another device with the same account, an external
 * counterparty, or a long-lived wallet can drive `highestFinalizedIndex`
 * above K. After PXE advances to N, its next scan is `(N, N + WINDOW_LEN]`
 * — partially outside our cache if `N > K - WINDOW_LEN`.
 *
 * The fix: after each round, find the highest local index with logs. If
 * activity sits within the last PXE_WINDOW_LEN indices of the scanned
 * range, scan another window from where we stopped. Stop on the first
 * fully-empty window (matching PXE's own exit condition) or when a
 * `PXE_WINDOW_LEN`-wide empty tail exists above the highest activity.
 *
 * # Parallelism
 *
 * Each triple is scanned independently and in parallel via Promise.all.
 * Within a triple, extension rounds serialize (each round depends on the
 * previous round's result to decide whether to continue), but most
 * triples need 0 or 1 round, so wall-clock cost is dominated by the
 * single slowest triple.
 *
 * Failures are non-fatal: a single failed round terminates that triple
 * without aborting others.
 */
export async function warmTags(opts: WarmTagsOptions): Promise<WarmTagsResult> {
  const t0 = Date.now();
  const requested = opts.windowSize ?? DEFAULT_WARM_WINDOW;
  const windowSize = Math.min(Math.max(1, requested), MAX_TAGS_PER_RPC);
  const { proxy, accounts, senders, contracts, anchorHash, log } = opts;

  // Sender set: registered senders ∪ wallet accounts. PXE's
  // `#getSecretsForSenders` builds the same union.
  const senderUniverse: AztecAddress[] = [
    ...senders,
    ...accounts.map((a) => a.address),
  ];
  const seen = new Set<string>();
  const dedupedSenders = senderUniverse.filter((s) => {
    const k = s.toString();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  log?.(
    `enumeration: accounts=${accounts.length} senders=${senders.length}` +
      ` → senderUniverse=${senderUniverse.length} dedupedSenders=${dedupedSenders.length}` +
      ` × contracts=${contracts.length} → triples=${accounts.length * dedupedSenders.length * contracts.length}`,
  );

  // Enumerate triples up front. Empty contracts/senders sets short-circuit
  // to zero work without firing any RPC.
  type Triple = {
    recipient: RecipientKeyMaterial;
    sender: AztecAddress;
    app: AztecAddress;
  };
  const triples: Triple[] = [];
  for (const recipient of accounts) {
    for (const sender of dedupedSenders) {
      for (const app of contracts) {
        triples.push({ recipient, sender, app });
      }
    }
  }
  if (triples.length === 0) {
    return {
      triples: 0,
      tagsQueried: 0,
      rpcBatches: 0,
      triplesWithHits: 0,
      logsFound: 0,
      durationMs: Date.now() - t0,
      triplesExtended: 0,
    };
  }

  // Scan each triple in parallel; within a triple, iterate rounds.
  const perTriple = await Promise.all(
    triples.map((t) => scanTriple(proxy, t, anchorHash, windowSize, log)),
  );

  let tagsQueried = 0;
  let rpcBatches = 0;
  let triplesWithHits = 0;
  let logsFound = 0;
  let triplesExtended = 0;
  const allTxHashes = new Set<string>();
  for (const r of perTriple) {
    tagsQueried += r.tagsQueried;
    rpcBatches += r.batches;
    logsFound += r.logsFound;
    if (r.hadHits) triplesWithHits++;
    if (r.extended) triplesExtended++;
    for (const h of r.txHashes) allTxHashes.add(h);
  }

  // Phase E (receipt + effect pre-warming).
  //
  // Every txHash that appeared in our warmed tagged-log results is a
  // tx PXE will iterate during `sender_sync`'s
  // `get_status_change_of_pending` (a `getTxReceipt` call), and the
  // simulator may later call `getTxEffect` for the same hashes. Fire
  // both fan-outs in parallel; each cache-populates a future PXE call.
  //
  // Observed savings on testnet swap boot: ~50 receipt + ~50 effect
  // upstream calls collapse into one round-trip each, eliminating
  // ~14s of sequential network time from the user-perceived "is the
  // app ready yet" wait.
  let receiptsWarmed = 0;
  let effectsWarmed = 0;
  let receiptsFailed = 0;
  let effectsFailed = 0;
  if (allTxHashes.size > 0) {
    const hashes = Array.from(allTxHashes);
    const proxyView = proxy as unknown as {
      getTxReceipt: (txHash: TxHash) => Promise<unknown>;
      getTxEffect: (txHash: TxHash) => Promise<unknown>;
    };
    // Use the stdlib `TxHash` class so JSON-RPC serialization works.
    // A bare `{ toString: () => h }` stub serializes to `{}` and the
    // node rejects it as malformed.
    const txHashObjs: TxHash[] = [];
    for (const h of hashes) {
      try {
        txHashObjs.push(TxHash.fromString(h));
      } catch (err) {
        log?.(`pre-warm: failed to parse txHash ${h}`, err);
      }
    }
    const settled = await Promise.allSettled([
      ...txHashObjs.map((tx) =>
        proxyView.getTxReceipt(tx).then(() => "rcpt" as const),
      ),
      ...txHashObjs.map((tx) =>
        proxyView.getTxEffect(tx).then(() => "eff" as const),
      ),
    ]);
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]!;
      const kind = i < txHashObjs.length ? "rcpt" : "eff";
      if (s.status === "fulfilled") {
        if (kind === "rcpt") receiptsWarmed++;
        else effectsWarmed++;
      } else {
        if (kind === "rcpt") receiptsFailed++;
        else effectsFailed++;
      }
    }
    log?.(
      `pre-warmed: tx hashes from logs=${allTxHashes.size},` +
        ` receipts=${receiptsWarmed}/${txHashObjs.length} (failed=${receiptsFailed}),` +
        ` effects=${effectsWarmed}/${txHashObjs.length} (failed=${effectsFailed})`,
    );
  }

  return {
    triples: triples.length,
    tagsQueried,
    rpcBatches,
    triplesWithHits,
    logsFound,
    durationMs: Date.now() - t0,
    triplesExtended,
  };
}

/**
 * Scan a single (sender, recipient, app) triple across as many
 * `windowSize`-wide rounds as needed. Stops on the first empty window
 * (no activity ever, or we've passed the last activity), and otherwise
 * extends until the upper `PXE_WINDOW_LEN` indices are empty above the
 * highest seen activity.
 */
async function scanTriple(
  proxy: CachingNodeProxy,
  triple: { recipient: RecipientKeyMaterial; sender: AztecAddress; app: AztecAddress },
  anchorHash: { toString(): string },
  windowSize: number,
  log?: (msg: string, err?: unknown) => void,
): Promise<TripleResult> {
  const state: TripleResult = {
    batches: 0,
    tagsQueried: 0,
    logsFound: 0,
    hadHits: false,
    extended: false,
    txHashes: new Set<string>(),
  };
  let fromIndex = 0;
  let round = 0;
  while (fromIndex < MAX_INDICES_PER_TRIPLE) {
    const count = Math.min(windowSize, MAX_INDICES_PER_TRIPLE - fromIndex);

    let tags: SiloedTag[] | undefined;
    try {
      tags = await computeSiloedTagsForWindow(
        triple.recipient,
        triple.sender,
        triple.app,
        fromIndex,
        count,
      );
    } catch (err) {
      log?.(`derive failed at index ${fromIndex}`, err);
      return state;
    }
    if (!tags) return state;

    let logsByTag: unknown[][];
    try {
      logsByTag = (await (proxy as unknown as {
        getPrivateLogsByTags: (
          tags: SiloedTag[],
          page: number,
          anchor: unknown,
        ) => Promise<unknown[][]>;
      }).getPrivateLogsByTags(tags, 0, anchorHash)) as unknown[][];
    } catch (err) {
      log?.(`rpc failed at index ${fromIndex}`, err);
      return state;
    }
    state.batches++;
    state.tagsQueried += tags.length;
    if (round > 0) state.extended = true;
    round++;

    // Locate the highest local index that returned at least one log,
    // sum log counts, and harvest tx hashes for downstream
    // receipt/effect pre-warming.
    let highestLocal = -1;
    for (let i = 0; i < logsByTag.length; i++) {
      const arr = logsByTag[i];
      if (Array.isArray(arr) && arr.length > 0) {
        highestLocal = i;
        state.logsFound += arr.length;
        state.hadHits = true;
        for (const entry of arr) {
          const tx = (entry as { txHash?: { toString(): string } })?.txHash;
          if (tx) state.txHashes.add(tx.toString());
        }
      }
    }

    if (highestLocal === -1) {
      // Fully empty window. Either no activity has ever happened for
      // this triple (cold device) or we've passed every prior tag.
      // Either way PXE's next scan from `highestFinalizedIndex ≤ fromIndex`
      // sits entirely inside our cached range. Done.
      return state;
    }

    // `highestLocal` is in [0, count). Empty-tail width is
    // `count - 1 - highestLocal`. If that already exceeds PXE's
    // window, PXE's next scan from `fromIndex + highestLocal` falls
    // wholly within our cache. Stop.
    const emptyTail = count - 1 - highestLocal;
    if (emptyTail >= PXE_WINDOW_LEN) return state;

    // Activity in the upper PXE_WINDOW_LEN — PXE may scan into the
    // next window. Extend.
    fromIndex += count;
  }
  // Safety cap reached. Don't loop forever; log so production sees it.
  log?.(
    `scanTriple hit MAX_INDICES_PER_TRIPLE=${MAX_INDICES_PER_TRIPLE} — check for runaway tag emission`,
  );
  return state;
}
