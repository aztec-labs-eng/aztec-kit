import type { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  FunctionType,
  type AztecAddressLike,
  type ContractArtifact,
  type FunctionCall,
} from "@aztec/aztec.js/abi";
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AuthWitness } from "@aztec/stdlib/auth-witness";
import { Gas } from "@aztec/stdlib/gas";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import {
  SubscriptionFPCContract,
  SubscriptionFPCContractArtifact,
} from "../noir/artifacts/SubscriptionFPC.js";
import { computeVarArgsHash, computeCalldataHash } from "@aztec/stdlib/hash";
import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import { HashedValues } from "@aztec/stdlib/tx";
import { NO_FROM } from "@aztec/aztec.js/account";
import {
  FPC_SPONSOR_OVERHEAD_DA_GAS_PRIVATE,
  FPC_SPONSOR_OVERHEAD_DA_GAS_PUBLIC,
  FPC_SPONSOR_OVERHEAD_L2_GAS_PRIVATE,
  FPC_SPONSOR_OVERHEAD_L2_GAS_PUBLIC,
  FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE,
  FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC,
  FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE,
  FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC,
  FPC_TEARDOWN_DA_GAS,
  FPC_TEARDOWN_L2_GAS,
} from "./fpc-gas-constants.js";
import type { DeployInstantiationOptions } from "@aztec/aztec.js/contracts";

/**
 * Overhead the FPC adds on top of the sponsored function's gas.
 * `subscribe` is the cold path (notes + nullifiers for slot + subscription);
 * `sponsor` reuses the existing subscription so it's cheaper. Both vary
 * further based on whether the tx contains a public phase — the FPC's own
 * private note ops get repriced at AVM rates in that case.
 *
 * `hasPublicCall` reflects the **whole tx**'s pricing regime, not just the
 * sponsored fn's top-level type: a private-typed fn that enqueues a public
 * call (e.g. via `self.call(...)` into a public fn) still shifts the tx
 * into public pricing. Pass `true` iff anything in the sponsored call's
 * transitive execution ends up in a public phase.
 */
export function fpcSubscribeOverhead(hasPublicCall: boolean): Gas {
  return new Gas(
    hasPublicCall ? FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC : FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE,
    hasPublicCall ? FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC : FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE,
  );
}

export function fpcSponsorOverhead(hasPublicCall: boolean): Gas {
  return new Gas(
    hasPublicCall ? FPC_SPONSOR_OVERHEAD_DA_GAS_PUBLIC : FPC_SPONSOR_OVERHEAD_DA_GAS_PRIVATE,
    hasPublicCall ? FPC_SPONSOR_OVERHEAD_L2_GAS_PUBLIC : FPC_SPONSOR_OVERHEAD_L2_GAS_PRIVATE,
  );
}

const FPC_TEARDOWN_GAS = new Gas(FPC_TEARDOWN_DA_GAS, FPC_TEARDOWN_L2_GAS);

/**
 * Measures the gas a sponsored fn uses when dispatched through the FPC,
 * and returns it standalone (overhead subtracted).
 *
 * Calibrates by simulating `fpc.calibrate(noirCall, adminAddress)` at top
 * of stack (`from: NO_FROM`), matching the call shape of `subscribe`/
 * `sponsor` at runtime. The `calibrate` entrypoint mirrors `subscribe`'s
 * dispatch (`_call_sponsored_fn`) but skips slot pop / subscription
 * insert / fee-payer / phase-change machinery, so it has no on-chain
 * side effects and no fee. Auth uses an inner-hash authwit signed by the
 * admin (consumer = FPC, innerHash = poseidon over (selector, args_hash)
 * with the AUTHWIT_INNER domain separator). The admin gate is what makes
 * this safe to expose: a sponsored call dispatched here runs with
 * `msg_sender == FPC_ADDRESS`, so without the gate any user could
 * impersonate the FPC.
 *
 * The returned `daGas` / `l2Gas` are the sponsored fn's own gas — callers
 * add whatever overhead fits their runtime path (`fpcSubscribeOverhead` /
 * `fpcSponsorOverhead`) when they actually send.
 */
export async function calibrateSponsoredApp(params: {
  /** FPC admin wallet — signs the calibrate authwit and simulates */
  adminWallet: EmbeddedWallet;
  /** FPC admin address — the authwit signer */
  adminAddress: AztecAddress;
  /** Address of the already-deployed FPC */
  fpcAddress: AztecAddress;
  /** Sample FunctionCall to measure (from `method(...).getFunctionCall()`) */
  sampleCall: FunctionCall;
  /** Auth witnesses required by the sponsored call */
  authWitnesses?: AuthWitness[];
  /** Additional scopes required by the sponsored call during simulation */
  additionalScopes?: AztecAddress[];
  /** Overrides the sender address used to derive discovery tags. Defaults to adminAddress. */
  sendMessagesAs?: AztecAddress;
}): Promise<{ daGas: number; l2Gas: number; hasPublicCall: boolean }> {
  const {
    adminWallet,
    adminAddress,
    fpcAddress,
    sampleCall,
    authWitnesses = [],
    additionalScopes = [],
    sendMessagesAs,
  } = params;

  const adminFpc = SubscriptionFPCContract.at(fpcAddress, adminWallet);
  const noirCall = await buildNoirFunctionCall(sampleCall);
  const calibrateInteraction = adminFpc.methods.calibrate(noirCall, adminAddress);

  // Mint an inner-hash authwit binding admin's signature to this exact
  // calibrate call (selector + args_hash). The Noir contract recomputes
  // the same inner_hash and verifies via `assert_inner_hash_valid_authwit`
  // — admin is consumer-bound to `fpcAddress`. Top-of-stack means no
  // msg_sender, which is why we can't use the standard call-intent flow.
  const calibrateCall = await calibrateInteraction.getFunctionCall();
  const calibrateArgsHash = await computeVarArgsHash(calibrateCall.args);
  const innerHash = await computeInnerAuthWitHash([
    calibrateCall.selector.toField(),
    calibrateArgsHash,
  ]);
  const calibrateAuthwit = await adminWallet.createAuthWit(adminAddress, {
    consumer: fpcAddress,
    innerHash,
  });

  const calibrateInteractionWithAuth = calibrateInteraction.with({
    authWitnesses: [calibrateAuthwit, ...authWitnesses],
    extraHashedArgs: await buildExtraHashedArgs(sampleCall),
  });

  // Build the execution payload ourselves so we can call wallet.simulateTx
  // directly and inspect publicInputs for enqueued public calls — the
  // top-level `simulate({ estimateGas })` API only returns gas numbers and
  // loses the public-phase signal we need to pick the right overhead
  // constant.
  const payload = await calibrateInteractionWithAuth.request();
  const simulated = await adminWallet.simulateTx(payload, {
    from: NO_FROM,
    sendMessagesAs: sendMessagesAs ?? adminAddress,
    fee: { gasSettings: {} },
    additionalScopes: [adminAddress, fpcAddress, ...additionalScopes],
    skipTxValidation: true,
    skipFeeEnforcement: true,
  });

  // A private fn can enqueue public work (e.g. `self.call(...)` to a
  // public fn). When that happens the tx shifts into public pricing —
  // the FPC's own private side effects get repriced at AVM rates — so
  // we must use the PUBLIC overhead constant, not the PRIVATE one.
  // `numberOfPublicCallRequests()` catches both public top-level calls
  // and public calls enqueued from private.
  const hasPublicCall = simulated.publicInputs.numberOfPublicCallRequests() > 0;

  // Return raw simulation gas. `calibrate` runs the sponsored fn under the
  // exact same call path it'll take at runtime (top-of-stack FPC entrypoint,
  // `msg_sender == FPC`, with authwit consumption when applicable),
  // so this number IS the "standalone" gas from the operator's perspective —
  // runtime callers add `fpcSubscribeOverhead`/`fpcSponsorOverhead` on top
  // and land on the exact runtime gas. Pinned by `fpc-overhead.test.ts`.
  return {
    daGas: Number(simulated.gasUsed.totalGas.daGas),
    l2Gas: Number(simulated.gasUsed.totalGas.l2Gas),
    hasPublicCall,
  };
}

/**
 * Converts a TS FunctionCall into the Noir FunctionCall struct shape
 * expected by the SubscriptionFPC's `sponsor` method.
 */
/**
 * For public calls, the args_hash is computed over [selector, ...args] (the full calldata).
 * For private calls, it's computed over just args.
 * See encoding.ts in @aztec/entrypoints for the canonical behavior.
 */
export async function buildNoirFunctionCall(call: FunctionCall) {
  const isPublic = call.type === FunctionType.PUBLIC;
  // Public calldata = [selector, ...args] hashed with the public calldata domain separator.
  // Private args are hashed with the function args domain separator.
  const argsHash = isPublic
    ? await computeCalldataHash([call.selector.toField(), ...call.args])
    : await computeVarArgsHash(call.args);
  return {
    args_hash: argsHash,
    function_selector: call.selector.toField(),
    hide_msg_sender: call.hideMsgSender,
    is_static: call.isStatic,
    target_address: call.to,
    is_public: isPublic,
  };
}

/**
 * Builds the HashedValues for the sponsored call's extra hashed args.
 * Public calls use HashedValues.fromCalldata([selector, ...args]).
 * Private calls use HashedValues.fromArgs(args).
 */
export async function buildExtraHashedArgs(call: FunctionCall): Promise<HashedValues[]> {
  const isPublic = call.type === FunctionType.PUBLIC;
  if (isPublic) {
    return [await HashedValues.fromCalldata([call.selector.toField(), ...call.args])];
  }
  return [await HashedValues.fromArgs(call.args)];
}

/**
 * Subscribes to the SubscriptionFPC and sends a call in a single tx.
 *
 * `gasLimits` is the sponsored fn's gas as it runs through the FPC dispatch
 * path — i.e. the value returned by `calibrateSponsoredApp`, or any
 * equivalent measurement of the function with `msg_sender == FPC` (so any
 * authwit consumption is accounted for). The helper adds the `subscribe`-
 * path FPC overhead on top.
 */
export async function subscribeAndCall(params: {
  /** SubscriptionFPC contract instance (connected to the user's wallet) */
  fpc: SubscriptionFPCContract;
  /** The FunctionCall to sponsor (from .getFunctionCall()) */
  call: FunctionCall;
  /** The config index for the sponsored app */
  configIndex: number;
  /** The subscribing user's address */
  userAddress: AztecAddress;
  /** Sponsored fn's gas under FPC dispatch (no subscribe/sponsor overhead) */
  gasLimits: { daGas: number; l2Gas: number };
  /** Whether the sponsored call has a public phase (from calibration) */
  hasPublicCall: boolean;
  /** Auth witnesses required by the sponsored call */
  authWitnesses?: AuthWitness[];
  /** Overrides the sender address used to derive discovery tags. Defaults to userAddress. */
  sendMessagesAs?: AztecAddress;
}) {
  const {
    fpc,
    call,
    configIndex,
    userAddress,
    gasLimits,
    hasPublicCall,
    authWitnesses = [],
    sendMessagesAs,
  } = params;

  const totalGasLimits = new Gas(gasLimits.daGas, gasLimits.l2Gas).add(
    fpcSubscribeOverhead(hasPublicCall),
  );

  const noirCall = await buildNoirFunctionCall(call);

  return fpc.methods
    .subscribe(noirCall, configIndex, userAddress)
    .with({
      authWitnesses,
      extraHashedArgs: await buildExtraHashedArgs(call),
    })
    .send({
      from: NO_FROM,
      sendMessagesAs: sendMessagesAs ?? userAddress,
      additionalScopes: [userAddress, fpc.address],
      fee: {
        gasSettings: {
          gasLimits: totalGasLimits,
          teardownGasLimits: FPC_TEARDOWN_GAS,
        },
      },
    });
}

/**
 * Sends a sponsored call through the SubscriptionFPC.
 *
 * `gasLimits` is the sponsored fn's gas as it runs through the FPC dispatch
 * path — i.e. the value returned by `calibrateSponsoredApp`, or any
 * equivalent measurement of the function with `msg_sender == FPC`. The
 * helper adds the `sponsor`-path FPC overhead on top. `sponsor`'s overhead
 * is smaller than `subscribe`'s because the subscription already exists.
 */
export async function sendSponsoredCall(params: {
  /** SubscriptionFPC contract instance (connected to the user's wallet) */
  fpc: SubscriptionFPCContract;
  /** The FunctionCall to sponsor (from .getFunctionCall()) */
  call: FunctionCall;
  /** The config index for the sponsored app */
  configIndex: number;
  /** The subscribing user's address */
  userAddress: AztecAddress;
  /** Sponsored fn's gas under FPC dispatch (no subscribe/sponsor overhead) */
  gasLimits: { daGas: number; l2Gas: number };
  /** Whether the sponsored call has a public phase (from calibration) */
  hasPublicCall: boolean;
  /** Auth witnesses required by the sponsored call */
  authWitnesses?: AuthWitness[];
  /** Overrides the sender address used to derive discovery tags. Defaults to userAddress. */
  sendMessagesAs?: AztecAddress;
}) {
  const {
    fpc,
    call,
    configIndex,
    userAddress,
    gasLimits,
    hasPublicCall,
    authWitnesses = [],
    sendMessagesAs,
  } = params;

  const totalGasLimits = new Gas(gasLimits.daGas, gasLimits.l2Gas).add(
    fpcSponsorOverhead(hasPublicCall),
  );

  const noirCall = await buildNoirFunctionCall(call);

  return fpc.methods
    .sponsor(noirCall, configIndex, userAddress)
    .with({
      authWitnesses,
      extraHashedArgs: await buildExtraHashedArgs(call),
    })
    .send({
      from: NO_FROM,
      sendMessagesAs: sendMessagesAs ?? userAddress,
      additionalScopes: [userAddress, fpc.address],
      fee: {
        gasSettings: {
          gasLimits: totalGasLimits,
          teardownGasLimits: FPC_TEARDOWN_GAS,
        },
      },
    });
}

/**
 * Wrapper around the codegen'd SubscriptionFPCContract that adds helper methods
 * for common operations (setup calibration, sending sponsored calls).
 */
export class SubscriptionFPC {
  constructor(public readonly contract: SubscriptionFPCContract) {}

  // --- Delegated properties ---

  get address(): AztecAddress {
    return this.contract.address;
  }

  get methods(): SubscriptionFPCContract["methods"] {
    return this.contract.methods;
  }

  withWallet(wallet: Wallet): SubscriptionFPC {
    return new SubscriptionFPC(this.contract.withWallet(wallet));
  }

  // --- Delegated statics ---

  static at(address: AztecAddress, wallet: Wallet): SubscriptionFPC {
    return new SubscriptionFPC(SubscriptionFPCContract.at(address, wallet));
  }

  static deploy(
    wallet: Wallet,
    admin: AztecAddressLike,
    instantiation?: DeployInstantiationOptions,
  ) {
    return SubscriptionFPCContract.deploy(wallet, admin, instantiation);
  }

  static get artifact(): ContractArtifact {
    return SubscriptionFPCContractArtifact;
  }

  // --- Helpers ---

  get helpers() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const fpc = this;
    return {
      /**
       * Measures a sponsored fn's standalone gas by simulating the FPC's
       * admin-only `calibrate` entrypoint. Pure simulation — no on-chain
       * state changes, no fees.
       */
      calibrate: (params: {
        adminWallet: EmbeddedWallet;
        adminAddress: AztecAddress;
        sampleCall: FunctionCall;
        authWitnesses?: AuthWitness[];
        additionalScopes?: AztecAddress[];
        sendMessagesAs?: AztecAddress;
      }) =>
        calibrateSponsoredApp({
          ...params,
          fpcAddress: fpc.address,
        }),

      /**
       * Subscribes and sends a sponsored call through the FPC.
       */
      subscribe: (params: {
        call: FunctionCall;
        configIndex: number;
        userAddress: AztecAddress;
        gasLimits: { daGas: number; l2Gas: number };
        hasPublicCall: boolean;
        authWitnesses?: AuthWitness[];
        sendMessagesAs?: AztecAddress;
      }) =>
        subscribeAndCall({
          ...params,
          fpc: fpc.contract,
        }),

      /**
       * Sends a sponsored call through the FPC.
       */
      sponsor: (params: {
        call: FunctionCall;
        configIndex: number;
        userAddress: AztecAddress;
        gasLimits: { daGas: number; l2Gas: number };
        hasPublicCall: boolean;
        authWitnesses?: AuthWitness[];
        sendMessagesAs?: AztecAddress;
      }) =>
        sendSponsoredCall({
          ...params,
          fpc: fpc.contract,
        }),
    };
  }
}
