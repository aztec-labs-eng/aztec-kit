/**
 * Extended EmbeddedWallet with initializerless Schnorr account support.
 *
 * The initializerless account is a proper account type that flows through the
 * standard createAccountInternal → AccountManager → getAccountFromAddress pipeline.
 *
 * Storage layout for initializerless accounts in WalletDB:
 *   type:       'schnorr-initializerless' (cast to AccountType — WalletDB stores as a raw string)
 *   secretKey:  the account secret key (Fr)
 *   salt:       the actualSalt (Fr) — the derived salt is recomputed on the fly
 *   signingKey: the signing private key (Fq buffer, derivable from secretKey but stored for consistency)
 */

import { collectOffchainEffects, type ExecutionPayload, TxStatus } from "@aztec/stdlib/tx";
import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import {
  type InteractionWaitOptions,
  NO_WAIT,
  type SendReturn,
  extractOffchainOutput,
  ContractFunctionInteraction,
  getGasLimits,
} from "@aztec/aztec.js/contracts";
import { waitForTx } from "@aztec/aztec.js/node";
import type { SendOptions } from "@aztec/aztec.js/wallet";
import { CallAuthorizationRequest } from "@aztec/aztec.js/authorization";
import { AccountManager } from "@aztec/aztec.js/wallet";
import { txProgress, type PhaseTiming, type TxProgressEvent } from "./tx-progress";
import {
  EmbeddedWallet as EmbeddedWalletBase,
  type EmbeddedWalletOptions,
  type AccountType,
} from "@aztec/wallets/embedded";
import { AztecSQLiteOPFSStore } from "@aztec/kv-store/sqlite-opfs";
import { createLogger } from "@aztec/foundation/log";
import { Fr } from "@aztec/foundation/curves/bn254";
import { deriveMasterIncomingViewingSecretKey } from "@aztec/stdlib/keys";
import {
  createSchnorrInitializerlessAccount,
  computeContractSalt,
  serializeSigningKey,
} from "./initializerless-account";
import { registerSqliteInspectors } from "./sqlite-inspector";
import { registerNodeProxyInspector } from "./node-proxy-inspector";
import { EncryptionKeyMismatchError, type StoreName } from "./encryption-key-mismatch-error";
import {
  createCachingNodeProxy,
  warmTags,
  type CachingNodeProxy,
  type RecipientKeyMaterial,
} from "./node-proxy";
import { GasSettings } from "@aztec/stdlib/gas";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { CompleteAddress, ContractInstanceWithAddress } from "@aztec/stdlib/contract";

/**
 * Sqlite3mc raises one of these messages when the supplied key fails to
 * decrypt page 1 of an existing database. The strings are pinned by tests in
 * encrypted-store.test.ts — if a future nightly changes them, those tests
 * fail loudly rather than letting `EncryptionKeyMismatchError` silently
 * regress to a generic `Error` (which would defeat its purpose for callers).
 */
const SQLITE3MC_DECRYPT_ERROR_PATTERNS = [
  /file is not a database/i,
  /file is encrypted or is not a database/i,
];

function isDecryptError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return SQLITE3MC_DECRYPT_ERROR_PATTERNS.some((p) => p.test(err.message));
}

async function openEncryptedOrPlain(
  storeName: StoreName,
  log: ReturnType<typeof createLogger>,
  dbName: string,
  poolDirectory: string,
  getEncryptionKey: (() => Promise<Uint8Array>) | undefined,
): Promise<AztecSQLiteOPFSStore> {
  // Re-derive a FRESH 32-byte key per open(). Upstream open() transfers the
  // buffer, detaching the caller's view — we can't reuse one buffer for two
  // opens.
  const key = getEncryptionKey ? await getEncryptionKey() : undefined;
  try {
    return await AztecSQLiteOPFSStore.open(log, dbName, false, poolDirectory, key);
  } catch (err) {
    if (key && isDecryptError(err)) {
      throw new EncryptionKeyMismatchError({ storeName, cause: err });
    }
    throw err;
  }
}

/** The initializerless type string — cast to AccountType for WalletDB storage. */
export const INITIALIZERLESS_TYPE = "schnorr-initializerless" as AccountType;

/** Extra options supported by this wallet on top of `EmbeddedWalletOptions`. */
export type EmbeddedWalletExtraOptions = {
  /**
   * When true, register dev-only inspectors on `window`:
   *   - `window.__aztecStores` — ad-hoc SQL + `.sqlite` export for pxe/wallet stores
   *   - `window.__txProfiler` — live tx-progress history + subscribe + phase roll-up
   *
   * Not compatible with `ephemeral: true` — no sqlite-opfs store exists to inspect.
   */
  inspect?: boolean;

  /**
   * If provided, both the PXE store and the walletDB store are opened with
   * sqlite3mc page-level encryption (ChaCha20). The callback is invoked once
   * per store (twice total per create()) and must return a fresh 32-byte
   * Uint8Array each call — the upstream open() *transfers* the buffer to its
   * worker, so a shared buffer would detach between the two open() calls.
   *
   * Not compatible with `ephemeral: true` (sqlite3mc doesn't encrypt :memory:
   * databases) — passing both throws synchronously.
   *
   * If the on-disk data was encrypted with a different key (or wasn't
   * encrypted at all), open() throws — wrapped here as
   * `EncryptionKeyMismatchError`. Consumers typically respond by wiping the
   * affected OPFS dir and re-onboarding.
   */
  getEncryptionKey?: () => Promise<Uint8Array>;
};

export class EmbeddedWallet extends EmbeddedWalletBase {
  /**
   * Our own reference to the walletDB store. The SDK's `WalletDB` doesn't expose
   * its backing store, so `stop()` has no way to close it — we capture it here so
   * our overridden `stop()` can release the SAH Pool's OPFS lock on the way out.
   */
  #walletStore?: { close?: () => Promise<void> };

  /**
   * Caching proxy interposed between PXE and the upstream Aztec node. Set in
   * `create()`. Stays the same instance for the lifetime of the wallet. Pure
   * passive cache; the warm-up (below) is what pre-populates it.
   */
  #nodeProxy?: CachingNodeProxy;

  /**
   * Per-account key material the tag warmer needs. Populated on every
   * `createAccountInternal` call (both fresh accounts and rehydration
   * during boot). The IVSK is the master incoming viewing secret key
   * derived from the account secret — pure stdlib derivation, no PXE
   * round-trip — paired with the `CompleteAddress` returned by the
   * account contract.
   */
  #accountKeys = new Map<string, RecipientKeyMaterial>();

  /** Debounce handle for warm-up scheduling. */
  #warmTimer?: ReturnType<typeof setTimeout>;
  /** Set to true while a warm-up is in flight (best-effort coalescing). */
  #warmInFlight = false;
  /** Set when a trigger arrives mid-cycle; another cycle fires once the current one ends. */
  #warmRequestedAgain = false;
  /**
   * Promise that resolves when the current warm-up (if any) finishes.
   * `simulateTx` / `executeUtility` overrides `await` this so the first
   * user-driven simulate after boot doesn't race the warm. After the
   * promise settles it's replaced with `Promise.resolve()`, so steady-
   * state calls pay no latency cost.
   */
  #currentWarmPromise: Promise<void> = Promise.resolve();
  /** Test hook: latest warm-up result, if any. */
  #lastWarmResult?: Awaited<ReturnType<typeof warmTags>>;
  /**
   * When set (via `inspect: true`), the warm-up emits one-line
   * `[warm] …` diagnostics on `console.info`. Captured by the testnet
   * e2e to validate the warm actually fired before user interaction.
   */
  #warmLog?: (msg: string, err?: unknown) => void;

  /**
   * Overrides `EmbeddedWalletBase.create` with our defaults:
   *   - `proverEnabled: true` by default (we want proving on against local-network);
   *     caller can opt out by passing `pxe: { proverEnabled: false }`.
   *   - When not `ephemeral`, default `pxe.store` and `walletDb.store` to
   *     `AztecSQLiteOPFSStore` instances scoped by rollup address. A caller may still
   *     inject their own stores and they win.
   *   - `inspect: true` registers the dev window hooks after creation.
   */
  static override async create<T extends EmbeddedWalletBase = EmbeddedWallet>(
    nodeOrUrl: string | AztecNode,
    options: EmbeddedWalletOptions & EmbeddedWalletExtraOptions = {},
  ): Promise<T> {
    const { inspect, getEncryptionKey, ...rest } = options;

    if (inspect && rest.ephemeral) {
      throw new Error(
        "`inspect: true` is incompatible with `ephemeral: true` (no persistent store to inspect)",
      );
    }

    if (getEncryptionKey && rest.ephemeral) {
      throw new Error(
        "`getEncryptionKey` is incompatible with `ephemeral: true` (sqlite3mc does not encrypt :memory: databases)",
      );
    }

    const rawNode = typeof nodeOrUrl === "string" ? createAztecNodeClient(nodeOrUrl) : nodeOrUrl;
    // Wrap the upstream node in our caching proxy. PXE and every downstream
    // path receives the proxy — the proxy is itself an AztecNode at the
    // type level. Construction is RPC-free.
    const node = createCachingNodeProxy(rawNode);
    const rootLogger = rest.logger ?? createLogger("embedded-wallet");

    // Prover on by default; caller can opt out by passing `pxe: { proverEnabled: false }`
    // (e.g. apps do this under VITE_DISABLE_PROVER=1 for e2e CI where proving
    // starves the node's event loop).
    const pxeOptions = { proverEnabled: true, ...rest.pxe };

    let finalOptions: EmbeddedWalletOptions;
    let pxeStore: AztecSQLiteOPFSStore | undefined;
    let walletStore: AztecSQLiteOPFSStore | undefined;

    if (rest.ephemeral) {
      finalOptions = { ...rest, pxe: pxeOptions };
    } else {
      const { rollupAddress } = await node.getL1ContractAddresses();
      const rollup = rollupAddress.toString();

      // Only open defaults the caller didn't already fill in.
      const pxeStoreOverride = pxeOptions.store as AztecSQLiteOPFSStore | undefined;
      pxeStore =
        pxeStoreOverride ??
        (await openEncryptedOrPlain(
          "pxe",
          rootLogger.createChild("pxe:data:sqlite-opfs"),
          `pxe_data_${rollup}`,
          `.aztec-kv-pxe-${rollup}`,
          getEncryptionKey,
        ));
      try {
        walletStore =
          (rest.walletDb?.store as AztecSQLiteOPFSStore | undefined) ??
          (await openEncryptedOrPlain(
            "wallet",
            rootLogger.createChild("wallet:data:sqlite-opfs"),
            `wallet_data_${rollup}`,
            `.aztec-kv-wallet-${rollup}`,
            getEncryptionKey,
          ));
      } catch (err) {
        // Don't leak the pxe store's SAH Pool lock if the wallet store
        // fails to open. Only close stores we opened ourselves — leave
        // caller-provided stores alone.
        if (pxeStore && !pxeStoreOverride) {
          await pxeStore.close().catch(() => {
            // Best-effort; let the original (more informative) error
            // propagate rather than masking it with a cleanup failure.
          });
        }
        throw err;
      }

      finalOptions = {
        ...rest,
        logger: rootLogger,
        pxe: { ...pxeOptions, store: pxeStore },
        walletDb: { ...rest.walletDb, store: walletStore },
      };
    }

    const wallet = await super.create<T>(node, finalOptions);

    // Gas on Aztec is deterministic per-call: the estimator's output is the
    // exact amount the tx will consume, assuming the args and caller match.
    // Padding covers for non-determinism we don't have, and actively hurts
    // the SubscriptionFPC flow — `max_fee` is sized against the unpadded
    // estimate, so a padded `send()` overshoots the slot's committed cap
    // and trips the private assertion. Zero padding by default.
    wallet.setEstimatedGasPadding(0);

    if (walletStore) {
      (wallet as unknown as EmbeddedWallet).#walletStore = walletStore;
    }

    const self = wallet as unknown as EmbeddedWallet;
    self.#nodeProxy = node;
    if (inspect) {
      self.#warmLog = (msg, err) =>
        console.info(`[warm] ${msg}` + (err ? ` (err=${String(err)})` : ""));
    }

    // Force every persisted account to materialize so each one's keys
    // route through our `createAccountInternal` override and land in
    // `#accountKeys`. Without this, the first warm-up after fresh boot
    // would have no recipient material (the base wallet defers account
    // materialization until something asks for it).
    try {
      const accounts = await wallet.getAccounts();
      for (const a of accounts) {
        await (
          self as unknown as {
            getAccountFromAddress: (addr: AztecAddress) => Promise<unknown>;
          }
        )
          .getAccountFromAddress(a.item)
          .catch(() => undefined);
      }
    } catch {
      // Non-fatal — the wallet still works, the first warm-up just won't
      // see persisted accounts until something else materializes them.
    }

    if (inspect && pxeStore && walletStore) {
      registerSqliteInspectors({ pxe: pxeStore, wallet: walletStore });
    }
    if (inspect) {
      // window.__nodeProxy.{stats, dump, reset}. Auto-dumps to the
      // console every 5s if anything has changed.
      registerNodeProxyInspector(node);
    }

    // Kick the first warm-up. Most often nothing happens yet — contracts
    // haven't been registered — but if accounts and contracts are already
    // persisted from a previous session, this prepopulates the cache so
    // the first sim is fast.
    self.#scheduleWarmTags(0);

    return wallet;
  }

  /**
   * Test/internal: expose the caching proxy for inspection. Not part of
   * the public surface (consumers should treat the wallet as a plain
   * Wallet). Intentionally underscored so it's unmistakable.
   */
  get __nodeProxy(): CachingNodeProxy | undefined {
    return this.#nodeProxy;
  }

  /** Test/internal: result of the most recent warm-up cycle, if any. */
  get __lastWarmResult(): Awaited<ReturnType<typeof warmTags>> | undefined {
    return this.#lastWarmResult;
  }

  /**
   * The SDK's `stop()` closes the PXE (and its store) but not the walletDB store.
   * Close it here so the SAH Pool's OPFS lock is released on the way out.
   */
  override async stop(): Promise<void> {
    if (this.#warmTimer) {
      clearTimeout(this.#warmTimer);
      this.#warmTimer = undefined;
    }
    await super.stop();
    if (this.#walletStore?.close) {
      await this.#walletStore.close();
    }
  }

  /**
   * Capture an account's key material for the tag warmer. Called from
   * every `createAccountInternal` path (fresh account or rehydration) so
   * the warmer always has up-to-date `(address, completeAddress, ivsk)`
   * tuples without any walletDB round-trips at warm time.
   */
  #recordAccountKeys(address: AztecAddress, completeAddress: CompleteAddress, secret: Fr): void {
    const ivsk = deriveMasterIncomingViewingSecretKey(secret);
    this.#accountKeys.set(address.toString(), { address, completeAddress, ivsk });
  }

  /**
   * Schedule a warm-up. Multiple rapid triggers (e.g. boot-time
   * registerContract storm) collapse into one cycle after a short
   * debounce. Safe to call before `#nodeProxy` is wired — the cycle
   * itself bails if nothing is available yet.
   *
   * Critically, this installs a PENDING `#currentWarmPromise` BEFORE
   * the warm actually runs. Any `simulateTx` / `executeUtility` call
   * that fires between scheduling and the warm's completion will
   * await this promise — closing the race where the first sim runs
   * during the 200ms debounce window with a cold cache.
   */
  #scheduleWarmTags(debounceMs = 200): void {
    if (this.#warmTimer) clearTimeout(this.#warmTimer);
    // If a previous warm is still in flight (or scheduled), keep its
    // promise pending; we want simulates to wait for whichever cycle
    // is the "current" one. Only install a new pending promise if the
    // current one is already resolved.
    if (this.#currentWarmPromise === Promise.resolve()) {
      // (Identity comparison is fine: we only ever assign exactly
      // `Promise.resolve()` to mean "no warm pending".)
      this.#currentWarmPromise = new Promise<void>((resolve) => {
        this.#warmPromiseResolver = resolve;
      });
    } else if (!this.#warmPromiseResolver) {
      // Defensive: previously-set promise but no resolver — install a
      // fresh one. Should not normally happen.
      this.#currentWarmPromise = new Promise<void>((resolve) => {
        this.#warmPromiseResolver = resolve;
      });
    }
    this.#warmTimer = setTimeout(() => {
      this.#warmTimer = undefined;
      void this.warmTagCache().catch(() => undefined);
    }, debounceMs);
  }

  /** Resolver paired with `#currentWarmPromise`. */
  #warmPromiseResolver?: () => void;

  /**
   * Derive every tag PXE will scan for the wallet's registered state
   * (accounts × {accounts ∪ registered senders} × registered contracts)
   * and batch-fetch them through the caching proxy. Pure crypto +
   * parallel RPCs; finishes in ~one network round-trip.
   *
   * Safe to call repeatedly. Designed to be fire-and-forget — exceptions
   * are caught and logged at the call site (or swallowed).
   */
  async warmTagCache(opts?: { windowSize?: number }): Promise<void> {
    // Always resolve any pending `#currentWarmPromise` before returning,
    // even on early-exits — otherwise `simulateTx` / `executeUtility`
    // would await a promise that never resolves and the entire wallet
    // would deadlock the moment a simulate fires before contracts are
    // registered. The resolver pairing is per CALL of this method.
    const finishPendingPromise = () => {
      const resolver = this.#warmPromiseResolver;
      this.#warmPromiseResolver = undefined;
      if (resolver) {
        this.#currentWarmPromise = Promise.resolve();
        resolver();
      }
    };

    const proxy = this.#nodeProxy;
    if (!proxy) {
      finishPendingPromise();
      return;
    }
    if (this.#warmInFlight) {
      // Coalesce — another warm is already running. Remember that
      // something changed so we re-fire once the current cycle finishes.
      // Don't touch the resolver: the in-flight cycle owns it.
      this.#warmRequestedAgain = true;
      this.#warmLog?.("trigger arrived mid-cycle, queued");
      return;
    }
    if (this.#accountKeys.size === 0) {
      this.#warmLog?.("skipped: no account keys yet");
      finishPendingPromise();
      return;
    }

    let senders: AztecAddress[];
    let contracts: AztecAddress[];
    try {
      // PXE owns the canonical lists; reading them avoids hint-state
      // duplication in the wallet. registerSender/registerContract have
      // already populated these by the time the debounce fires.
      [senders, contracts] = await Promise.all([
        this.pxe.getSenders(),
        this.pxe.getContracts(),
      ]);
    } catch (err) {
      this.#warmLog?.("skipped: pxe.getSenders/getContracts threw", err);
      finishPendingPromise();
      return;
    }
    if (contracts.length === 0) {
      this.#warmLog?.("skipped: no contracts registered yet");
      finishPendingPromise();
      return;
    }

    // Resolve a fresh anchor. Routes through the proxy so the sniffer
    // learns the current tip and the warm's `scannedAtBlock` is correct.
    let anchorHash: { toString(): string };
    try {
      const tips = (await (proxy as unknown as { getL2Tips: () => Promise<unknown> }).getL2Tips()) as {
        proposed?: { hash: { toString(): string } };
      } | undefined;
      const proposedHash = tips?.proposed?.hash;
      if (!proposedHash) {
        this.#warmLog?.("skipped: no proposed tip yet");
        finishPendingPromise();
        return;
      }
      anchorHash = proposedHash;
    } catch (err) {
      this.#warmLog?.("skipped: getL2Tips threw", err);
      finishPendingPromise();
      return;
    }

    // Diagnostic: cross-check PXE's view of registered accounts against
    // our `#accountKeys`. If they diverge, PXE is scanning tags for
    // accounts whose ivsks we don't have — those queries will MISS
    // our warm cache by definition. The boot e2e captures this line
    // to explain leftover misses.
    try {
      const pxeAccounts = await this.pxe.getRegisteredAccounts();
      if (pxeAccounts.length !== this.#accountKeys.size) {
        this.#warmLog?.(
          `account-set mismatch: pxe.getRegisteredAccounts()=${pxeAccounts.length} vs #accountKeys=${this.#accountKeys.size}` +
            ` (some PXE-known accounts have no ivsk in the wallet — their tags can't be warmed)`,
        );
      }
    } catch {
      /* introspection-only; ignore */
    }

    this.#warmInFlight = true;
    this.#warmRequestedAgain = false;
    this.#warmLog?.(
      `start: accounts=${this.#accountKeys.size} senders=${senders.length} contracts=${contracts.length}`,
    );
    // Ensure a pending promise exists for simulate-waiters. Normally
    // `#scheduleWarmTags` already installed one; if `warmTagCache()` is
    // called directly (test / app), install one here.
    if (!this.#warmPromiseResolver) {
      this.#currentWarmPromise = new Promise<void>((resolve) => {
        this.#warmPromiseResolver = resolve;
      });
    }
    try {
      this.#lastWarmResult = await warmTags({
        proxy,
        accounts: Array.from(this.#accountKeys.values()),
        senders,
        contracts,
        anchorHash,
        windowSize: opts?.windowSize,
        log: this.#warmLog,
      });
      const r = this.#lastWarmResult;
      this.#warmLog?.(
        `done: triples=${r.triples} batches=${r.rpcBatches} extended=${r.triplesExtended} tags=${r.tagsQueried} logs=${r.logsFound} elapsed=${r.durationMs}ms`,
      );
    } catch (err) {
      this.#warmLog?.("threw", err);
    } finally {
      this.#warmInFlight = false;
      // Promise hand-off: if another warm has been queued, install a
      // fresh pending promise SO SIMULATES CONTINUE TO WAIT. Otherwise
      // resolve and mark the slot empty for zero-latency steady-state.
      const resolver = this.#warmPromiseResolver;
      if (this.#warmRequestedAgain) {
        this.#currentWarmPromise = new Promise<void>((resolve) => {
          this.#warmPromiseResolver = resolve;
        });
      } else {
        this.#warmPromiseResolver = undefined;
        this.#currentWarmPromise = Promise.resolve();
      }
      resolver?.();
    }
    // A trigger arrived mid-cycle (typically a new registerContract).
    // The current warm-up might have missed it; fire one more cycle.
    if (this.#warmRequestedAgain) {
      this.#warmRequestedAgain = false;
      this.#scheduleWarmTags(0);
    }
  }

  /**
   * Hook the base `registerContract` to trigger a warm-up. The new
   * contract becomes an `app` PXE will eventually scan tags against —
   * pre-deriving them now pays off the next time the user interacts.
   *
   * Additionally, when `secretKey` is provided the base wallet's
   * `registerContract` internally calls `pxe.registerAccount(secretKey,
   * partialAddress)` — registering an account contract whose ivsk
   * PXE will iterate in `#getSecretsForSenders`. We capture the
   * secret here so the warmer can derive that account's tags too.
   * Without this, the swap app's SubscriptionFPC registration adds a
   * second account to PXE whose 12 tag-windows × 100 indices each
   * (~1200 tags per cycle) are all cache misses, dropping the hit
   * rate from ~95%+ to 76%.
   */
  override async registerContract(
    ...args: Parameters<EmbeddedWalletBase["registerContract"]>
  ): ReturnType<EmbeddedWalletBase["registerContract"]> {
    const out = await super.registerContract(...args);
    const secretKey = args[2] as Fr | undefined;
    if (secretKey) {
      // The base call has already done `pxe.registerAccount(secretKey,
      // partialAddress)` on our behalf. Mirror it into `#accountKeys`
      // so the warmer covers this account's secret enumeration.
      try {
        const instance = args[0] as ContractInstanceWithAddress;
        await this.#noteAccountFromContract(instance, secretKey);
      } catch (err) {
        // Non-fatal — the wallet still works, the warm just won't
        // cover this account's tags until something else materializes
        // the keys.
        this.#warmLog?.("noteAccountFromContract threw", err);
      }
    }
    this.#scheduleWarmTags();
    return out;
  }

  /**
   * Mirror an account contract registration (via `registerContract` with
   * a secretKey) into `#accountKeys`. Derives the ivsk locally and
   * looks up the complete address from PXE's address store so the
   * warmer can include this account in tag enumeration.
   */
  async #noteAccountFromContract(
    instance: ContractInstanceWithAddress,
    secret: Fr,
  ): Promise<void> {
    if (this.#accountKeys.has(instance.address.toString())) return;
    // PXE has just been told about this account via `registerAccount`;
    // its addressStore now has the complete address.
    const completeAddress = await (
      this.pxe as unknown as {
        getRegisteredAccounts: () => Promise<CompleteAddress[]>;
      }
    )
      .getRegisteredAccounts()
      .then((all) => all.find((a) => a.address.equals(instance.address)));
    if (!completeAddress) {
      this.#warmLog?.(
        `account ${instance.address.toString().slice(0, 12)}… registered via contract but missing from pxe.getRegisteredAccounts`,
      );
      return;
    }
    this.#warmLog?.(
      `account-from-contract: addr=${instance.address.toString().slice(0, 12)}… ` +
        `complete.address=${completeAddress.address.toString().slice(0, 12)}… match=${completeAddress.address.equals(instance.address)}`,
    );
    this.#recordAccountKeys(instance.address, completeAddress, secret);
  }

  /**
   * Hook the base `registerSender` to trigger a warm-up. The new sender
   * gets included in `pxe.getSenders()` and joins the iteration.
   */
  override async registerSender(
    ...args: Parameters<EmbeddedWalletBase["registerSender"]>
  ): ReturnType<EmbeddedWalletBase["registerSender"]> {
    const out = await super.registerSender(...args);
    this.#scheduleWarmTags();
    return out;
  }

  /**
   * Hook the base `simulateTx` to await any in-flight tag warm-up
   * before delegating. PXE's `syncTaggedPrivateLogs` fires inside
   * `simulateTx`'s execution path; if the warm hasn't populated the
   * cache by then, those scans hit the network. Waiting here costs
   * nothing in steady state (after warm completes `#currentWarmPromise`
   * is `Promise.resolve()`), but eliminates the boot-race that costs
   * the first sim its cache hits.
   */
  override async simulateTx(
    ...args: Parameters<EmbeddedWalletBase["simulateTx"]>
  ): ReturnType<EmbeddedWalletBase["simulateTx"]> {
    await this.#currentWarmPromise;
    return super.simulateTx(...args);
  }

  /**
   * Same await-for-warm hook on the utility (read-only) path. Most of
   * the swap app's onboarding queries (balance_of_private, etc.) go
   * through here, NOT simulateTx — without this hook the boot-race
   * lives on for them.
   */
  override executeUtility(
    ...args: Parameters<EmbeddedWalletBase["executeUtility"]>
  ): ReturnType<EmbeddedWalletBase["executeUtility"]> {
    return this.#currentWarmPromise.then(() => super.executeUtility(...args));
  }

  /**
   * Override to add the 'schnorr-initializerless' account type.
   *
   * For this type:
   *   - `salt` is the actualSalt (not derived) — we compute the derived salt on the fly
   *   - `signingKey` is the Fq signing private key buffer (standard, derivable from secret)
   *   - The AccountContract returns undefined from getInitializationFunctionAndArgs()
   *     so AccountManager computes the instance with initializationHash = Fr.ZERO
   *   - After registration, we store the immutables capsule in PXE
   */
  protected override async createAccountInternal(
    type: AccountType,
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<AccountManager> {
    if (type !== INITIALIZERLESS_TYPE) {
      const mgr = await super.createAccountInternal(type, secret, salt, signingKey);
      const account = await mgr.getAccount();
      this.#recordAccountKeys(mgr.address, account.getCompleteAddress(), secret);
      this.#scheduleWarmTags();
      return mgr;
    }

    // `salt` here is the actualSalt. Derive the contract salt from it + signing public key.
    const actualSalt = salt;
    const { account: accountContract, signingPublicKey } =
      await createSchnorrInitializerlessAccount(secret);
    const derivedSalt = await computeContractSalt(actualSalt, signingPublicKey);

    // AccountManager.create() uses the derived salt for address computation.
    // getInitializationFunctionAndArgs() returns undefined → initializationHash = Fr.ZERO.
    const accountManager = await AccountManager.create(this, secret, accountContract, derivedSalt);

    const instance = accountManager.getInstance();
    const existingInstance = await this.pxe.getContractInstance(instance.address);
    if (!existingInstance) {
      const artifact = await accountContract.getContractArtifact();
      await this.registerContract(instance, artifact, accountManager.getSecretKey());
    }

    // Always store/refresh the immutables capsule so the contract can verify the signing key.
    // This is idempotent — store_immutables validates against the salt before persisting.
    const artifact = await accountContract.getContractArtifact();
    const capsuleData = [actualSalt, ...(await serializeSigningKey(signingPublicKey))];
    const storeAbi = artifact.functions.find((f) => f.name === "store_immutables");
    if (storeAbi) {
      const storeCall = new ContractFunctionInteraction(this, instance.address, storeAbi, [
        capsuleData,
      ]);
      await storeCall.simulate({ from: instance.address });
    }

    const account = await accountManager.getAccount();
    this.#recordAccountKeys(accountManager.address, account.getCompleteAddress(), secret);
    this.#scheduleWarmTags();
    return accountManager;
  }

  /**
   * Creates and stores a new initializerless Schnorr account.
   * Returns the AccountManager — the account is immediately usable (no deployment needed).
   */
  async createInitializerlessAccount(secretKey?: Fr, actualSalt?: Fr): Promise<AccountManager> {
    const sk = secretKey ?? Fr.random();
    const as = actualSalt ?? Fr.random();

    // Derive signing key for WalletDB storage (standard Fq buffer)
    const { signingPrivateKey } = await createSchnorrInitializerlessAccount(sk);

    // Store actualSalt in the `salt` field. The derived salt is computed in createAccountInternal.
    return this.createAndStoreAccount(
      "main",
      INITIALIZERLESS_TYPE,
      sk,
      as, // actualSalt — NOT the derived salt
      signingPrivateKey.toBuffer(),
    );
  }

  /**
   * Loads an existing stored account. If none exists, returns null.
   * Works for both initializerless and standard account types.
   */
  async loadStoredAccount(): Promise<AccountManager | null> {
    const accounts = await this.getAccounts();
    if (accounts.length === 0) return null;

    const address = accounts[0].item;
    const { secretKey, salt, signingKey, type } = await this.walletDB.retrieveAccount(address);

    return this.createAccountInternal(type, secretKey, salt, signingKey);
  }

  /**
   * Returns the raw account data (secretKey, salt, type) for export/backup purposes.
   */
  async getAccountData(address: AztecAddress): Promise<{
    secretKey: Fr;
    salt: Fr;
    type: string;
  }> {
    const { secretKey, salt, type } = await this.walletDB.retrieveAccount(address);
    return { secretKey, salt, type: type as string };
  }

  /**
   * Checks if there is an existing stored account (without creating one).
   */
  async hasStoredAccount(): Promise<boolean> {
    const existing = await this.getAccounts();
    return existing.length > 0;
  }

  /**
   * Deletes the stored account so a fresh one can be created.
   */
  async deleteStoredAccount(): Promise<void> {
    const [account] = await this.getAccounts();
    if (account) {
      await this.walletDB.deleteAccount(account.item);
    }
  }

  override async sendTx<W extends InteractionWaitOptions = undefined>(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
  ): Promise<SendReturn<W>> {
    const txId = crypto.randomUUID();
    const startTime = Date.now();
    const phases: PhaseTiming[] = [];

    const fnName = executionPayload.calls?.[0]?.name ?? "Transaction";
    const label = fnName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    const emit = (phase: TxProgressEvent["phase"], extra?: Partial<TxProgressEvent>) => {
      txProgress.emit({
        txId,
        label,
        phase,
        startTime,
        phaseStartTime: Date.now(),
        phases: [...phases],
        ...extra,
      });
    };

    try {
      const feeOptions = await this.completeFeeOptions({
        from: opts.from,
        feePayer: executionPayload.feePayer,
        gasSettings: opts.fee?.gasSettings,
        forEstimation: true,
      });

      emit("simulating");
      const simStart = Date.now();
      const simulationResult = await this.simulateViaEntrypoint(executionPayload, {
        from: opts.from,
        feeOptions,
        additionalScopes: opts.additionalScopes,
        skipTxValidation: true,
        skipFeeEnforcement: true,
        sendMessagesAs: opts.sendMessagesAs,
      });
      const simElapsed = Date.now() - simStart;
      const offchainEffects = collectOffchainEffects(simulationResult.privateExecutionResult);
      const authWitStart = Date.now();
      const authWitnesses = await Promise.all(
        offchainEffects.map(async (effect) => {
          try {
            const authRequest = await CallAuthorizationRequest.fromFields(effect.data);
            return this.createAuthWit(authRequest.onBehalfOf, {
              consumer: effect.contractAddress,
              innerHash: authRequest.innerHash,
            });
          } catch {
            return undefined;
          }
        }),
      );
      const authWitDuration = Date.now() - authWitStart;
      for (const wit of authWitnesses) {
        if (wit) executionPayload.authWitnesses.push(wit);
      }
      const simulationDuration = simElapsed + authWitDuration;
      const simStats = simulationResult.stats;
      const breakdown: Array<{ label: string; duration: number }> = [];
      const details: string[] = [];
      if (simStats?.timings) {
        const t = simStats.timings;
        const prepareDuration = simElapsed - t.total;
        if (prepareDuration > 10) breakdown.push({ label: "Prepare", duration: prepareDuration });
        if (t.sync > 0) breakdown.push({ label: "Sync", duration: t.sync });
        if (t.perFunction.length > 0) {
          const witgenTotal = t.perFunction.reduce((sum, fn) => sum + fn.time, 0);
          breakdown.push({
            label: "Private execution",
            duration: witgenTotal,
          });
          for (const fn of t.perFunction) {
            breakdown.push({
              label: `  ${fn.functionName.split(":").pop() || fn.functionName}`,
              duration: fn.time,
            });
          }
        }
        if (t.publicSimulation)
          breakdown.push({
            label: "Public simulation",
            duration: t.publicSimulation,
          });
        if (t.unaccounted > 0) breakdown.push({ label: "Other", duration: t.unaccounted });
      }
      if (authWitDuration > 0)
        breakdown.push({ label: "Auth witnesses", duration: authWitDuration });
      if (simStats?.nodeRPCCalls?.roundTrips) {
        const rt = simStats.nodeRPCCalls.roundTrips;
        const fmt = (ms: number) =>
          ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
        details.push(`${rt.roundTrips} RPC round-trips (${fmt(rt.totalBlockingTime)} blocking)`);
      }
      phases.push({
        name: "Simulation",
        duration: simulationDuration,
        color: "#ce93d8",
        ...(breakdown.length > 0 && { breakdown }),
        ...(details.length > 0 && { details }),
      });

      emit("proving");
      const provingStart = Date.now();
      const estimated = getGasLimits(simulationResult, this.estimatedGasPadding);
      this.log.verbose(
        `Estimated gas limits for tx: DA=${estimated.gasLimits.daGas} L2=${estimated.gasLimits.l2Gas} teardownDA=${estimated.teardownGasLimits.daGas} teardownL2=${estimated.teardownGasLimits.l2Gas}`,
      );
      const gasSettings = GasSettings.from({
        ...opts.fee?.gasSettings,
        maxFeesPerGas: feeOptions.gasSettings.maxFeesPerGas,
        maxPriorityFeesPerGas: feeOptions.gasSettings.maxPriorityFeesPerGas,
        gasLimits: opts.fee?.gasSettings?.gasLimits ?? estimated.gasLimits,
        teardownGasLimits: opts.fee?.gasSettings?.teardownGasLimits ?? estimated.teardownGasLimits,
      });
      const txRequest = await this.createTxExecutionRequestFromPayloadAndFee(
        executionPayload,
        opts.from,
        { ...feeOptions, gasSettings },
      );
      const provenTx = await this.pxe.proveTx(txRequest, {
        scopes: this.scopesFrom(opts.from, opts.additionalScopes),
        senderForTags: this.senderForTagsFrom(opts.from, opts.sendMessagesAs),
      });
      const provingDuration = Date.now() - provingStart;
      const stats = provenTx.stats;
      if (stats?.timings) {
        const t = stats.timings;
        if (t.sync && t.sync > 0) phases.push({ name: "Sync", duration: t.sync, color: "#90caf9" });
        if (t.perFunction?.length > 0) {
          const witgenTotal = t.perFunction.reduce(
            (sum: number, fn: { time: number }) => sum + fn.time,
            0,
          );
          phases.push({
            name: "Witgen",
            duration: witgenTotal,
            color: "#ffb74d",
            breakdown: t.perFunction.map((fn: { functionName: string; time: number }) => ({
              label: fn.functionName.split(":").pop() || fn.functionName,
              duration: fn.time,
            })),
          });
        }
        if (t.proving && t.proving > 0)
          phases.push({
            name: "Proving",
            duration: t.proving,
            color: "#f48fb1",
          });
        if (t.unaccounted > 0)
          phases.push({
            name: "Other",
            duration: t.unaccounted,
            color: "#bdbdbd",
          });
      } else {
        phases.push({
          name: "Proving",
          duration: provingDuration,
          color: "#f48fb1",
        });
      }

      const offchainOutput = extractOffchainOutput(
        provenTx.getOffchainEffects(),
        provenTx.publicInputs.constants.anchorBlockHeader.globalVariables.timestamp,
      );

      const tx = await provenTx.toTx();
      const txHash = tx.getTxHash();
      emit("sending", { aztecTxHash: txHash.toString() });
      const sendingStart = Date.now();
      if (await this.aztecNode.getTxEffect(txHash)) {
        throw new Error(`A settled tx with equal hash ${txHash.toString()} exists.`);
      }
      await this.aztecNode.sendTx(tx);
      phases.push({
        name: "Sending",
        duration: Date.now() - sendingStart,
        color: "#2196f3",
      });

      if (opts.wait === NO_WAIT) {
        emit("complete");
        return { txHash, ...offchainOutput } as unknown as SendReturn<W>;
      }

      emit("mining");
      const miningStart = Date.now();
      const waitOpts = typeof opts.wait === "object" ? opts.wait : undefined;
      const receipt = await waitForTx(this.aztecNode, txHash, {
        ...waitOpts,
        waitForStatus: TxStatus.PROPOSED,
      });
      phases.push({
        name: "Mining",
        duration: Date.now() - miningStart,
        color: "#4caf50",
      });

      emit("complete");
      return { receipt, ...offchainOutput } as unknown as SendReturn<W>;
    } catch (err) {
      emit("error", {
        error: err instanceof Error ? err.message : "Transaction failed",
      });
      throw err;
    }
  }
}
