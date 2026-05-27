/**
 * Extended EmbeddedWallet with initializerless Schnorr account support.
 *
 * The initializerless account is a proper account type that flows through the
 * standard createAccountInternal → AccountManager → getAccountFromAddress pipeline.
 *
 * Storage layout for initializerless accounts in WalletDB:
 *   type:       'schnorr-initializerless' (cast to AccountType — WalletDB stores as a raw string)
 *   secretKey:  the account secret key (Fr)
 *   salt:       the contract instance salt (Fr) — plain random salt under AZIP-9
 *   signingKey: the signing private key (Fq buffer, derivable from secretKey but stored for consistency)
 *
 * The signing key is committed via `ContractInstance.immutables_hash`, not via
 * the salt. `instance.immutables_hash = poseidon2(serialized_immutables)`; the
 * capsule at IMMUTABLES_SLOT holds `serialized_immutables` directly.
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
import {
  createSchnorrInitializerlessAccount,
  serializeSigningKey,
} from "./initializerless-account";
import { computeImmutablesHash } from "./immutables";
import { SimulatedSchnorrInitializerlessAccountContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/SimulatedSchnorrInitializerlessAccount";
import { getContractClassFromArtifact } from "@aztec/stdlib/contract";
import { ExtendedAccountContractsProvider } from "./account-contracts-provider";
import { INITIALIZERLESS_TYPE } from "./initializerless-account-type";
import { registerSqliteInspectors } from "./sqlite-inspector";
import { EncryptionKeyMismatchError, type StoreName } from "./encryption-key-mismatch-error";
import { GasSettings } from "@aztec/stdlib/gas";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";

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

export { INITIALIZERLESS_TYPE } from "./initializerless-account-type";

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
   * Wraps the provider before handing it to the base so simulation's
   * stub-account dispatch recognizes `schnorr-initializerless`. The base's
   * `static create` instantiates the wallet via `new this(...)`, so our
   * constructor runs for every subclass `create` path (browser + node) and
   * `initStubClasses()` (called by base right after construction) already
   * sees the extended provider.
   */
  constructor(...args: ConstructorParameters<typeof EmbeddedWalletBase>) {
    const [pxe, aztecNode, walletDB, accountContracts, log] = args;
    super(pxe, aztecNode, walletDB, new ExtendedAccountContractsProvider(accountContracts), log);
  }

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

    const node = typeof nodeOrUrl === "string" ? createAztecNodeClient(nodeOrUrl) : nodeOrUrl;
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

    if (inspect && pxeStore && walletStore) {
      registerSqliteInspectors({ pxe: pxeStore, wallet: walletStore });
    }

    return wallet;
  }

  /**
   * The SDK's `stop()` closes the PXE (and its store) but not the walletDB store.
   * Close it here so the SAH Pool's OPFS lock is released on the way out.
   */
  override async stop(): Promise<void> {
    await super.stop();
    if (this.#walletStore?.close) {
      await this.#walletStore.close();
    }
  }

  /**
   * Registers ONLY our 'schnorr-initializerless' stub class with PXE — apps
   * built on this wallet only ever create initializerless accounts, so the
   * base's schnorr/ecdsaK/ecdsaR stub registrations would just bloat PXE's
   * class registry. If a consumer needs to simulate txs from a schnorr or
   * ecdsa account, override this method again and call `super.initStubClasses()`.
   */
  override async initStubClasses(): Promise<void> {
    const artifact = SimulatedSchnorrInitializerlessAccountContractArtifact;
    await this.pxe.registerContractClass(artifact);
    const { id } = await getContractClassFromArtifact(artifact);
    this.stubClassIds.set(INITIALIZERLESS_TYPE, id);
  }

  /**
   * Override to add the 'schnorr-initializerless' account type.
   *
   * For this type:
   *   - `salt` is a plain random salt — under AZIP-9 the signing key is committed
   *     via `instance.immutables_hash`, not the salt.
   *   - `signingKey` is the Fq signing private key buffer (standard, derivable from secret).
   *   - The AccountContract returns undefined from getInitializationFunctionAndArgs()
   *     so `initializationHash = Fr.ZERO`.
   *   - On *first* registration with PXE, we also store the immutables capsule.
   *     Subsequent loads skip both — PXE persists the capsule alongside the
   *     contract instance, so re-storing on every load would be wasted work.
   *     If PXE state is wiped, the missing-instance check below re-runs both.
   */
  protected override async createAccountInternal(
    type: AccountType,
    secret: Fr,
    salt: Fr,
    signingKey: Buffer,
  ): Promise<AccountManager> {
    if (type !== INITIALIZERLESS_TYPE) {
      return super.createAccountInternal(type, secret, salt, signingKey);
    }

    const { account: accountContract, signingPublicKey } =
      await createSchnorrInitializerlessAccount(secret);

    const artifact = await accountContract.getContractArtifact();
    const serializedImmutables = await serializeSigningKey(signingPublicKey);
    const immutablesHash = await computeImmutablesHash(serializedImmutables);

    const accountManager = await AccountManager.create(this, secret, accountContract, {
      salt,
      immutablesHash,
    });
    const instance = accountManager.getInstance();

    const existingInstance = await this.pxe.getContractInstance(instance.address);
    if (!existingInstance) {
      await this.registerContract(instance, artifact, secret);

      // First-time setup: store the immutables capsule so the contract can verify
      // the signing key. PXE keeps the capsule across loads; subsequent calls
      // through this path skip the store.
      const storeAbi = artifact.functions.find((f) => f.name === "store_immutables");
      if (storeAbi) {
        const storeCall = new ContractFunctionInteraction(this, instance.address, storeAbi, [
          serializedImmutables,
        ]);
        await storeCall.simulate({ from: instance.address });
      }
    }

    return accountManager;
  }

  /**
   * Creates and stores a new initializerless Schnorr account.
   * Returns the AccountManager — the account is immediately usable (no deployment needed).
   */
  async createInitializerlessAccount(secretKey?: Fr, salt?: Fr): Promise<AccountManager> {
    const sk = secretKey ?? Fr.random();
    const s = salt ?? Fr.random();

    // Derive signing key for WalletDB storage (standard Fq buffer)
    const { signingPrivateKey } = await createSchnorrInitializerlessAccount(sk);

    return this.createAndStoreAccount(
      "main",
      INITIALIZERLESS_TYPE,
      sk,
      s,
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
      // The PXE created by the embedded-wallet entrypoints runs with
      // `autoSync: false`, so no other call inside this method will pull a
      // fresh anchor block on its own. Doing it once here means simulate +
      // prove + send all share the same view of the chain — and we get to
      // report the sync as its own progress phase instead of having it
      // disappear inside the simulation timing breakdown.
      emit("syncing");
      const syncStart = Date.now();
      await this.pxe.sync();
      phases.push({
        name: "Sync",
        duration: Date.now() - syncStart,
        color: "#90caf9",
      });

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
        // `t.sync` is intentionally not surfaced here — with `autoSync: false`
        // the up-front `this.pxe.sync()` is the only sync that runs and we
        // report it as its own top-level phase.
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
        // `t.sync` here would only be non-zero if the base layer re-synced;
        // we've turned `autoSync` off and done one explicit sync at the top
        // of this method, so any reading here would be 0 and just noise.
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
