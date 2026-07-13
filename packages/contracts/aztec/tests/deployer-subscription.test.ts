import { describe, it, expect, beforeAll } from "vitest";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { randomBytes } from "@aztec/foundation/crypto/random";
import { Ecdsa } from "@aztec/foundation/crypto/ecdsa";
import type { AccountManager } from "@aztec/aztec.js/wallet";
import { Gas } from "@aztec/stdlib/gas";

import { EcdsaAccountDeployerContract } from "../noir/artifacts/EcdsaAccountDeployer.js";
import { SubscriptionFPC, fpcSubscribeOverhead } from "../lib/subscription-fpc.js";
import { setupTestContext, type FPCTestContext } from "./utils.js";

const PRODUCTION_INDEX = 100000 + Math.floor(Math.random() * 100000);
const SIGNING_PRIVATE_KEY = randomBytes(32);
const SIGNING_PUBLIC_KEY = await new Ecdsa("secp256r1").computePublicKey(SIGNING_PRIVATE_KEY);

let ctx: FPCTestContext;

beforeAll(async () => {
  ctx = await setupTestContext();
});

describe("Account deployment subscription", () => {
  let userWallet: EmbeddedWallet;
  let deployerAddress: AztecAddress;
  let subscribedAccountManager: AccountManager;
  let gasLimits: { daGas: number; l2Gas: number };
  let hasPublicCall: boolean;

  beforeAll(async () => {
    userWallet = ctx.userWallet;

    const deployerInstance = await getContractInstanceFromInstantiationParams(
      EcdsaAccountDeployerContract.artifact,
      { salt: new Fr(0) },
    );
    deployerAddress = deployerInstance.address;

    await ctx.wallet.registerContract(deployerInstance, EcdsaAccountDeployerContract.artifact);
    await userWallet.registerContract(deployerInstance, EcdsaAccountDeployerContract.artifact);
    await userWallet.registerContract(ctx.fpcInstance, SubscriptionFPC.artifact, ctx.fpcSecretKey);
    subscribedAccountManager = await userWallet.createECDSARAccount(
      await Fr.random(),
      await Fr.random(),
      SIGNING_PRIVATE_KEY,
    );
  });

  it("calibrates and sets up a sponsored app", async () => {
    const dummyAccount = await ctx.wallet.createECDSARAccount(
      await Fr.random(),
      await Fr.random(),
      SIGNING_PRIVATE_KEY,
    );
    const deploy = EcdsaAccountDeployerContract.at(deployerAddress, ctx.wallet).methods.deploy(
      dummyAccount.address,
      await Fr.random(),
      Array.from(SIGNING_PUBLIC_KEY.subarray(0, 32)),
      Array.from(SIGNING_PUBLIC_KEY.subarray(32, 64)),
    );
    const sampleCall = await deploy.getFunctionCall();

    const calibrated = await ctx.fpc.helpers.calibrate({
      adminWallet: ctx.wallet,
      adminAddress: ctx.admin,
      sampleCall,
      additionalScopes: [dummyAccount.address],
    });
    gasLimits = { daGas: calibrated.daGas, l2Gas: calibrated.l2Gas };
    hasPublicCall = calibrated.hasPublicCall;

    // Size max_fee against the subscribe-path composite with a 50× safety
    // multiplier — local fees are cheap but stable enough not to need P75.
    const subscribeTotal = new Gas(gasLimits.daGas, gasLimits.l2Gas).add(
      fpcSubscribeOverhead(hasPublicCall),
    );
    const currentFees = await ctx.node.getCurrentMinFees();
    const maxFee = subscribeTotal.computeFee(currentFees.mul(50)).toBigInt();
    expect(maxFee).toBeGreaterThan(0n);

    await ctx.fpc.methods
      .sign_up(sampleCall.to, sampleCall.selector, PRODUCTION_INDEX, 1, maxFee, 1)
      .send({ from: ctx.admin, additionalScopes: [ctx.fpc.address] });
  });

  it("allows a user to subscribe and get a sponsored call in the same tx", async () => {
    const fpc = ctx.fpc.withWallet(userWallet);
    const deployer = EcdsaAccountDeployerContract.at(deployerAddress, userWallet);

    subscribedAccountManager = await userWallet.createECDSARAccount(
      await Fr.random(),
      await Fr.random(),
      SIGNING_PRIVATE_KEY,
    );

    const subscriptionFPCInstance = await ctx.node.getContract(fpc.address);
    await userWallet.registerContract(subscriptionFPCInstance!, SubscriptionFPC.artifact);

    const sponsoredCall = await deployer.methods
      .deploy(
        subscribedAccountManager.address,
        await Fr.random(),
        Array.from(SIGNING_PUBLIC_KEY.subarray(0, 32)),
        Array.from(SIGNING_PUBLIC_KEY.subarray(32, 64)),
      )
      .getFunctionCall();

    await fpc.helpers.subscribe({
      call: sponsoredCall,
      configIndex: PRODUCTION_INDEX,
      userAddress: subscribedAccountManager.address,
      gasLimits,
      hasPublicCall,
    });
  });
});
