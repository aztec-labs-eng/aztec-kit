/**
 * FPC Gas Overhead Measurement
 *
 * Measures the gas overhead of both `subscribe` and `sponsor` calls in the
 * SubscriptionFPC, comparing standalone vs sponsored execution for public
 * and private functions.
 *
 * Subscribe is more expensive than sponsor because it pops a SlotNote
 * (from FPC storage) and creates a SubscriptionNote (in user storage),
 * while sponsor pops and re-inserts a SubscriptionNote (in user storage).
 *
 * The max_fee must cover the more expensive subscribe call. The difference
 * (subscribe_overhead - sponsor_overhead) is the "subscribe boost".
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Fr } from "@aztec/aztec.js/fields";
import { Gas } from "@aztec/stdlib/gas";
import { randomBytes } from "@aztec/foundation/crypto/random";
import { TokenContract, TokenContractArtifact } from "@aztec/noir-contracts.js/Token";
import { NO_FROM } from "@aztec/aztec.js/account";
import { SetPublicAuthwitContractInteraction } from "@aztec/aztec.js/authorization";

import { computeInnerAuthWitHash } from "@aztec/stdlib/auth-witness";
import { computeVarArgsHash } from "@aztec/stdlib/hash";

import {
  SubscriptionFPC,
  buildNoirFunctionCall,
  buildExtraHashedArgs,
} from "../lib/subscription-fpc.js";
import { SubscriptionFPCContract } from "../noir/artifacts/SubscriptionFPC.js";
import { setupTestContext, type FPCTestContext, type GasValues, toGas, logGas } from "./utils.js";
import {
  FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC,
  FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC,
  FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE,
  FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE,
  FPC_SPONSOR_OVERHEAD_L2_GAS_PUBLIC,
  FPC_SPONSOR_OVERHEAD_DA_GAS_PUBLIC,
  FPC_SPONSOR_OVERHEAD_L2_GAS_PRIVATE,
  FPC_SPONSOR_OVERHEAD_DA_GAS_PRIVATE,
  FPC_TEARDOWN_L2_GAS,
  FPC_TEARDOWN_DA_GAS,
} from "../lib/fpc-gas-constants.js";

const MAX_U128 = 2n ** 128n - 1n;
const PUBLIC_INDEX = 300000 + Math.floor(Math.random() * 100000);
const PRIVATE_INDEX = PUBLIC_INDEX + 1;
const SALT = Fr.random();
const SIGNING_PRIVATE_KEY = randomBytes(32);

let ctx: FPCTestContext;
let subscribePublicGas: GasValues;
let subscribePrivateGas: GasValues;
let sponsorPublicGas: GasValues;
let sponsorPrivateGas: GasValues;
let calibratePublicGas: GasValues;
let calibratePrivateGas: GasValues;

beforeAll(async () => {
  ctx = await setupTestContext();
});

describe("FPC gas overhead", () => {
  beforeAll(async () => {
    // ── Deploy token and set up accounts ──────────────────────────────
    const { contract: rawToken, instance: tokenInstance } = await TokenContract.deploy(
      ctx.wallet,
      ctx.admin,
      "OverheadToken",
      "OT",
      18,
    ).send({
      from: ctx.admin,
    });
    const token = rawToken;

    const userWallet = ctx.userWallet;
    await userWallet.registerContract(ctx.fpcInstance, SubscriptionFPC.artifact, ctx.fpcSecretKey);
    await userWallet.registerContract(tokenInstance, TokenContractArtifact);

    const userSecret = Fr.random();
    const userAccountManager = await ctx.wallet.createECDSARAccount(
      userSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    const userAddress = userAccountManager.address;
    await (await userAccountManager.getDeployMethod()).send({ from: ctx.admin });
    await userWallet.createECDSARAccount(userSecret, SALT, SIGNING_PRIVATE_KEY);

    const recipientSecret = Fr.random();
    const recipientAccountManager = await ctx.wallet.createECDSARAccount(
      recipientSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    const recipientAddress = recipientAccountManager.address;
    await (await recipientAccountManager.getDeployMethod()).send({ from: ctx.admin });
    await userWallet.createECDSARAccount(recipientSecret, SALT, SIGNING_PRIVATE_KEY);

    await token.methods.mint_to_public(ctx.admin, 100000n).send({ from: ctx.admin });
    await token.methods.mint_to_private(ctx.admin, 100000n).send({ from: ctx.admin });
    await token.methods.mint_to_private(userAddress, 100000n).send({ from: ctx.admin });
    await userWallet.registerSender(ctx.admin, "admin");

    const adminFpc = SubscriptionFPCContract.at(ctx.fpc.address, ctx.wallet);

    // ── Public subscribe + sponsor ───────────────────────────────────

    // Sign up with max_uses=2
    {
      const authwitNonce = Fr.random();
      const action = token.methods.transfer_in_public(
        ctx.admin,
        recipientAddress,
        10n,
        authwitNonce,
      );
      const setAuthwit = await SetPublicAuthwitContractInteraction.create(
        ctx.wallet,
        ctx.admin,
        { caller: ctx.fpc.address, action },
        true,
      );
      await setAuthwit.send();
      const sampleCall = await action.getFunctionCall();

      await ctx.fpc.methods
        .sign_up(sampleCall.to, sampleCall.selector, PUBLIC_INDEX, 2, MAX_U128, 1)
        .send({ from: ctx.admin });

      // Measure subscribe
      const noirCall = await buildNoirFunctionCall(sampleCall);
      const { estimatedGas } = await adminFpc.methods
        .subscribe(noirCall, PUBLIC_INDEX, ctx.admin)
        .with({ extraHashedArgs: await buildExtraHashedArgs(sampleCall) })
        .simulate({
          from: NO_FROM,
          sendMessagesAs: ctx.admin,
          fee: { estimateGas: true, estimatedGasPadding: 0 },
          additionalScopes: [ctx.admin, ctx.fpc.address],
        });
      subscribePublicGas = toGas(estimatedGas!);

      // Execute subscribe to create subscription for the sponsor test.
      // Use the just-measured `subscribePublicGas` directly (it's the full
      // gas the subscribe path takes); no need to add overhead through
      // `fpc.helpers.subscribe`.
      await adminFpc.methods
        .subscribe(noirCall, PUBLIC_INDEX, ctx.admin)
        .with({ extraHashedArgs: await buildExtraHashedArgs(sampleCall) })
        .send({
          from: NO_FROM,
          sendMessagesAs: ctx.admin,
          additionalScopes: [ctx.admin, ctx.fpc.address],
          fee: {
            gasSettings: {
              gasLimits: new Gas(
                subscribePublicGas.gasLimits.daGas,
                subscribePublicGas.gasLimits.l2Gas,
              ),
            },
          },
        });
    }

    // Measure sponsor
    {
      const authwitNonce = Fr.random();
      const action = token.methods.transfer_in_public(
        ctx.admin,
        recipientAddress,
        10n,
        authwitNonce,
      );
      const setAuthwit = await SetPublicAuthwitContractInteraction.create(
        ctx.wallet,
        ctx.admin,
        { caller: ctx.fpc.address, action },
        true,
      );
      await setAuthwit.send();
      const sampleCall = await action.getFunctionCall();
      const noirCall = await buildNoirFunctionCall(sampleCall);

      const { estimatedGas } = await adminFpc.methods
        .sponsor(noirCall, PUBLIC_INDEX, ctx.admin)
        .with({ extraHashedArgs: await buildExtraHashedArgs(sampleCall) })
        .simulate({
          from: NO_FROM,
          sendMessagesAs: ctx.admin,
          fee: { estimateGas: true, estimatedGasPadding: 0 },
          additionalScopes: [ctx.admin, ctx.fpc.address],
        });
      sponsorPublicGas = toGas(estimatedGas!);
    }

    // Measure calibrate (public). `calibrate` is top-of-stack like
    // `subscribe`/`sponsor` (no admin-account hop), gated by an inner-hash
    // authwit signed by admin.
    {
      const authwitNonce = Fr.random();
      const action = token.methods.transfer_in_public(
        ctx.admin,
        recipientAddress,
        10n,
        authwitNonce,
      );
      const setAuthwit = await SetPublicAuthwitContractInteraction.create(
        ctx.wallet,
        ctx.admin,
        { caller: ctx.fpc.address, action },
        true,
      );
      await setAuthwit.send();
      const sampleCall = await action.getFunctionCall();
      const noirCall = await buildNoirFunctionCall(sampleCall);

      const calibrateInteraction = adminFpc.methods.calibrate(noirCall, ctx.admin);
      const calibrateCall = await calibrateInteraction.getFunctionCall();
      const calibrateArgsHash = await computeVarArgsHash(calibrateCall.args);
      const innerHash = await computeInnerAuthWitHash([
        calibrateCall.selector.toField(),
        calibrateArgsHash,
      ]);
      const calibrateAuthwit = await ctx.wallet.createAuthWit(ctx.admin, {
        consumer: ctx.fpc.address,
        innerHash,
      });

      const { estimatedGas } = await calibrateInteraction
        .with({
          authWitnesses: [calibrateAuthwit],
          extraHashedArgs: await buildExtraHashedArgs(sampleCall),
        })
        .simulate({
          from: NO_FROM,
          sendMessagesAs: ctx.admin,
          fee: { estimateGas: true, estimatedGasPadding: 0 },
          additionalScopes: [ctx.admin, ctx.fpc.address],
          skipTxValidation: true,
          skipFeeEnforcement: true,
        });
      calibratePublicGas = toGas(estimatedGas!);
    }

    // ── Private subscribe + sponsor ──────────────────────────────────

    // Sign up once for the private transfer selector (uses random nonces for each call)
    {
      const signUpCall = await token.methods
        .transfer_in_private(ctx.admin, recipientAddress, 10n, 0)
        .getFunctionCall();
      await ctx.fpc.methods
        .sign_up(signUpCall.to, signUpCall.selector, PRIVATE_INDEX, 2, MAX_U128, 1)
        .send({ from: ctx.admin });
    }

    // Measure subscribe (unique nonce for simulation)
    {
      const nonce1 = Fr.random();
      const sampleCall = await token.methods
        .transfer_in_private(ctx.admin, recipientAddress, 10n, nonce1)
        .getFunctionCall();
      const authwit = await ctx.wallet.createAuthWit(ctx.admin, {
        caller: ctx.fpc.address,
        call: sampleCall,
      });

      const noirCall = await buildNoirFunctionCall(sampleCall);
      const { estimatedGas } = await adminFpc.methods
        .subscribe(noirCall, PRIVATE_INDEX, ctx.admin)
        .with({
          authWitnesses: [authwit],
          extraHashedArgs: await buildExtraHashedArgs(sampleCall),
        })
        .simulate({
          from: NO_FROM,
          sendMessagesAs: ctx.admin,
          fee: { estimateGas: true, estimatedGasPadding: 0 },
          additionalScopes: [ctx.admin, ctx.fpc.address],
        });
      subscribePrivateGas = toGas(estimatedGas!);
    }

    // Execute subscribe (unique nonce for the real tx). Use the just-
    // measured `subscribePrivateGas` directly to avoid the
    // `fpc.helpers.subscribe` overhead-addition path during test setup.
    {
      const nonce2 = Fr.random();
      const subCall = await token.methods
        .transfer_in_private(ctx.admin, recipientAddress, 10n, nonce2)
        .getFunctionCall();
      const subAuthwit = await ctx.wallet.createAuthWit(ctx.admin, {
        caller: ctx.fpc.address,
        call: subCall,
      });
      const subNoirCall = await buildNoirFunctionCall(subCall);
      await adminFpc.methods
        .subscribe(subNoirCall, PRIVATE_INDEX, ctx.admin)
        .with({
          authWitnesses: [subAuthwit],
          extraHashedArgs: await buildExtraHashedArgs(subCall),
        })
        .send({
          from: NO_FROM,
          sendMessagesAs: ctx.admin,
          additionalScopes: [ctx.admin, ctx.fpc.address],
          fee: {
            gasSettings: {
              gasLimits: new Gas(
                subscribePrivateGas.gasLimits.daGas,
                subscribePrivateGas.gasLimits.l2Gas,
              ),
            },
          },
        });
    }

    // Measure sponsor (unique nonce)
    {
      const nonce3 = Fr.random();
      const sampleCall = await token.methods
        .transfer_in_private(ctx.admin, recipientAddress, 10n, nonce3)
        .getFunctionCall();
      const authwit = await ctx.wallet.createAuthWit(ctx.admin, {
        caller: ctx.fpc.address,
        call: sampleCall,
      });
      const noirCall = await buildNoirFunctionCall(sampleCall);

      const { estimatedGas } = await adminFpc.methods
        .sponsor(noirCall, PRIVATE_INDEX, ctx.admin)
        .with({
          authWitnesses: [authwit],
          extraHashedArgs: await buildExtraHashedArgs(sampleCall),
        })
        .simulate({
          from: NO_FROM,
          sendMessagesAs: ctx.admin,
          fee: { estimateGas: true, estimatedGasPadding: 0 },
          additionalScopes: [ctx.admin, ctx.fpc.address],
        });
      sponsorPrivateGas = toGas(estimatedGas!);
    }

    // Measure calibrate (private)
    {
      const nonce4 = Fr.random();
      const sampleCall = await token.methods
        .transfer_in_private(ctx.admin, recipientAddress, 10n, nonce4)
        .getFunctionCall();
      const sponsoredAuthwit = await ctx.wallet.createAuthWit(ctx.admin, {
        caller: ctx.fpc.address,
        call: sampleCall,
      });
      const noirCall = await buildNoirFunctionCall(sampleCall);

      const calibrateInteraction = adminFpc.methods.calibrate(noirCall, ctx.admin);
      const calibrateCall = await calibrateInteraction.getFunctionCall();
      const calibrateArgsHash = await computeVarArgsHash(calibrateCall.args);
      const innerHash = await computeInnerAuthWitHash([
        calibrateCall.selector.toField(),
        calibrateArgsHash,
      ]);
      const calibrateAuthwit = await ctx.wallet.createAuthWit(ctx.admin, {
        consumer: ctx.fpc.address,
        innerHash,
      });

      const { estimatedGas } = await calibrateInteraction
        .with({
          authWitnesses: [calibrateAuthwit, sponsoredAuthwit],
          extraHashedArgs: await buildExtraHashedArgs(sampleCall),
        })
        .simulate({
          from: NO_FROM,
          sendMessagesAs: ctx.admin,
          fee: { estimateGas: true, estimatedGasPadding: 0 },
          additionalScopes: [ctx.admin, ctx.fpc.address],
          skipTxValidation: true,
          skipFeeEnforcement: true,
        });
      calibratePrivateGas = toGas(estimatedGas!);
    }

    // ── Print all measurements ───────────────────────────────────────

    console.log("=== ALL MEASUREMENTS ===");
    logGas("Calibrate public  ", calibratePublicGas);
    logGas("Calibrate private ", calibratePrivateGas);
    logGas("Subscribe public  ", subscribePublicGas);
    logGas("Subscribe private ", subscribePrivateGas);
    logGas("Sponsor public    ", sponsorPublicGas);
    logGas("Sponsor private   ", sponsorPrivateGas);
  });

  // ── TESTS ──────────────────────────────────────────────────────────

  it("teardown is equal across all FPC calls", () => {
    const teardownL2 = subscribePublicGas.teardownGasLimits.l2Gas;
    const teardownDA = subscribePublicGas.teardownGasLimits.daGas;
    expect(sponsorPublicGas.teardownGasLimits.l2Gas).toBe(teardownL2);
    expect(subscribePrivateGas.teardownGasLimits.l2Gas).toBe(teardownL2);
    expect(sponsorPrivateGas.teardownGasLimits.l2Gas).toBe(teardownL2);
    expect(sponsorPublicGas.teardownGasLimits.daGas).toBe(teardownDA);
    expect(subscribePrivateGas.teardownGasLimits.daGas).toBe(teardownDA);
    expect(sponsorPrivateGas.teardownGasLimits.daGas).toBe(teardownDA);
  });

  it("subscribe is equal or more expensive than sponsor", () => {
    const subscribeOverheadL2 =
      subscribePublicGas.gasLimits.l2Gas - calibratePublicGas.gasLimits.l2Gas;
    const sponsorOverheadL2 = sponsorPublicGas.gasLimits.l2Gas - calibratePublicGas.gasLimits.l2Gas;
    const boostL2 = subscribeOverheadL2 - sponsorOverheadL2;

    console.log(
      `Subscribe overhead L2=${subscribeOverheadL2}  Sponsor overhead L2=${sponsorOverheadL2}  Boost=${boostL2}`,
    );

    expect(subscribeOverheadL2).greaterThanOrEqual(sponsorOverheadL2);
  });

  // The contract that wraps `calibrateSponsoredApp` returns the raw simulation
  // gas as the "standalone" cost, and runtime callers add the appropriate
  // FPC overhead constant. For that pipeline to produce the *exact* runtime
  // gas, calibrate must already include everything that runs at runtime
  // except the slot/subscription bookkeeping that subscribe/sponsor add on
  // top. This test pins that invariant: calibrate gas + FPC overhead must
  // equal the measured subscribe/sponsor gas, exactly.
  it("calibrate + FPC overhead exactly matches subscribe/sponsor gas", () => {
    expect(calibratePublicGas.gasLimits.l2Gas + FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC).toBe(
      subscribePublicGas.gasLimits.l2Gas,
    );
    expect(calibratePublicGas.gasLimits.daGas + FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC).toBe(
      subscribePublicGas.gasLimits.daGas,
    );

    expect(calibratePrivateGas.gasLimits.l2Gas + FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE).toBe(
      subscribePrivateGas.gasLimits.l2Gas,
    );
    expect(calibratePrivateGas.gasLimits.daGas + FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE).toBe(
      subscribePrivateGas.gasLimits.daGas,
    );

    expect(calibratePublicGas.gasLimits.l2Gas + FPC_SPONSOR_OVERHEAD_L2_GAS_PUBLIC).toBe(
      sponsorPublicGas.gasLimits.l2Gas,
    );
    expect(calibratePublicGas.gasLimits.daGas + FPC_SPONSOR_OVERHEAD_DA_GAS_PUBLIC).toBe(
      sponsorPublicGas.gasLimits.daGas,
    );

    expect(calibratePrivateGas.gasLimits.l2Gas + FPC_SPONSOR_OVERHEAD_L2_GAS_PRIVATE).toBe(
      sponsorPrivateGas.gasLimits.l2Gas,
    );
    expect(calibratePrivateGas.gasLimits.daGas + FPC_SPONSOR_OVERHEAD_DA_GAS_PRIVATE).toBe(
      sponsorPrivateGas.gasLimits.daGas,
    );
  });

  it("captured constants match measured values", () => {
    // The four FPC overheads are measured separately for public and private
    // sponsored functions. They differ because when the sponsored function
    // enqueues a public call, the tx shifts into the public-pricing regime
    // and the FPC's own private side effects (note hashes + nullifiers from
    // its internal bookkeeping) get repriced at AVM rates. Keeping all four
    // constants in sync with measurement means callers that compute
    // `gasLimits = standalone + FPC_{SPONSOR,SUBSCRIBE}_OVERHEAD_{L2,DA}_GAS_{PRIVATE,PUBLIC}` pick
    // the right value for their sponsored fn's publicness.
    const measured = {
      subscribePublicL2: subscribePublicGas.gasLimits.l2Gas - calibratePublicGas.gasLimits.l2Gas,
      subscribePublicDA: subscribePublicGas.gasLimits.daGas - calibratePublicGas.gasLimits.daGas,
      subscribePrivateL2: subscribePrivateGas.gasLimits.l2Gas - calibratePrivateGas.gasLimits.l2Gas,
      subscribePrivateDA: subscribePrivateGas.gasLimits.daGas - calibratePrivateGas.gasLimits.daGas,
      sponsorPublicL2: sponsorPublicGas.gasLimits.l2Gas - calibratePublicGas.gasLimits.l2Gas,
      sponsorPublicDA: sponsorPublicGas.gasLimits.daGas - calibratePublicGas.gasLimits.daGas,
      sponsorPrivateL2: sponsorPrivateGas.gasLimits.l2Gas - calibratePrivateGas.gasLimits.l2Gas,
      sponsorPrivateDA: sponsorPrivateGas.gasLimits.daGas - calibratePrivateGas.gasLimits.daGas,
      teardownL2: subscribePublicGas.teardownGasLimits.l2Gas,
      teardownDA: subscribePublicGas.teardownGasLimits.daGas,
    };

    const mismatches =
      FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC !== measured.subscribePublicL2 ||
      FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC !== measured.subscribePublicDA ||
      FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE !== measured.subscribePrivateL2 ||
      FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE !== measured.subscribePrivateDA ||
      FPC_SPONSOR_OVERHEAD_L2_GAS_PUBLIC !== measured.sponsorPublicL2 ||
      FPC_SPONSOR_OVERHEAD_DA_GAS_PUBLIC !== measured.sponsorPublicDA ||
      FPC_SPONSOR_OVERHEAD_L2_GAS_PRIVATE !== measured.sponsorPrivateL2 ||
      FPC_SPONSOR_OVERHEAD_DA_GAS_PRIVATE !== measured.sponsorPrivateDA ||
      FPC_TEARDOWN_L2_GAS !== measured.teardownL2 ||
      FPC_TEARDOWN_DA_GAS !== measured.teardownDA;

    if (mismatches) {
      console.log("Update lib/fpc-gas-constants.ts:");
      console.log(
        `  export const FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC = ${measured.subscribePublicL2};`,
      );
      console.log(
        `  export const FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC = ${measured.subscribePublicDA};`,
      );
      console.log(
        `  export const FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE = ${measured.subscribePrivateL2};`,
      );
      console.log(
        `  export const FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE = ${measured.subscribePrivateDA};`,
      );
      console.log(
        `  export const FPC_SPONSOR_OVERHEAD_L2_GAS_PUBLIC = ${measured.sponsorPublicL2};`,
      );
      console.log(
        `  export const FPC_SPONSOR_OVERHEAD_DA_GAS_PUBLIC = ${measured.sponsorPublicDA};`,
      );
      console.log(
        `  export const FPC_SPONSOR_OVERHEAD_L2_GAS_PRIVATE = ${measured.sponsorPrivateL2};`,
      );
      console.log(
        `  export const FPC_SPONSOR_OVERHEAD_DA_GAS_PRIVATE = ${measured.sponsorPrivateDA};`,
      );
      console.log(`  export const FPC_TEARDOWN_L2_GAS = ${measured.teardownL2};`);
      console.log(`  export const FPC_TEARDOWN_DA_GAS = ${measured.teardownDA};`);
    }

    expect(FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC).toBe(measured.subscribePublicL2);
    expect(FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC).toBe(measured.subscribePublicDA);
    expect(FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE).toBe(measured.subscribePrivateL2);
    expect(FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE).toBe(measured.subscribePrivateDA);
    expect(FPC_SPONSOR_OVERHEAD_L2_GAS_PUBLIC).toBe(measured.sponsorPublicL2);
    expect(FPC_SPONSOR_OVERHEAD_DA_GAS_PUBLIC).toBe(measured.sponsorPublicDA);
    expect(FPC_SPONSOR_OVERHEAD_L2_GAS_PRIVATE).toBe(measured.sponsorPrivateL2);
    expect(FPC_SPONSOR_OVERHEAD_DA_GAS_PRIVATE).toBe(measured.sponsorPrivateDA);
    expect(FPC_TEARDOWN_L2_GAS).toBe(measured.teardownL2);
    expect(FPC_TEARDOWN_DA_GAS).toBe(measured.teardownDA);
  });
});
