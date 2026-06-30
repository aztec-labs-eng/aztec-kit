/**
 * Tests for the FPC getter (utility) functions:
 * - count_available_slots: returns remaining users for a config
 * - get_subscription_info: returns (has_subscription, remaining_uses) for a user
 *
 * Creates a subscription config with 100 user slots, subscribes several users,
 * and verifies the getters return correct values throughout.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { Fr } from "@aztec/aztec.js/fields";
import { Gas } from "@aztec/stdlib/gas";
import { randomBytes } from "@aztec/foundation/crypto/random";
import { TokenContract, TokenContractArtifact } from "@aztec/noir-contracts.js/Token";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

import { SubscriptionFPC, fpcSubscribeOverhead } from "../lib/subscription-fpc.js";
import { setupTestContext, type FPCTestContext } from "./utils.js";

const CONFIG_INDEX = 500000 + Math.floor(Math.random() * 100000);
const MAX_USERS = 100;
const MAX_USES = 3;
const SALT = Fr.random();
const SIGNING_PRIVATE_KEY = randomBytes(32);

let ctx: FPCTestContext;

beforeAll(async () => {
  ctx = await setupTestContext();
});

describe("FPC getters", () => {
  let token: TokenContract;
  let configId: Fr;
  let gasLimits: { daGas: number; l2Gas: number };
  let hasPublicCall: boolean;

  beforeAll(async () => {
    // Deploy token
    const { contract: rawToken } = await TokenContract.deploy(
      ctx.wallet,
      ctx.admin,
      "GetterToken",
      "GT",
      18,
    ).send({
      from: ctx.admin,
    });
    token = rawToken;

    // Mint tokens to admin for calibration
    await token.methods.mint_to_private(ctx.admin, 10000n).send({ from: ctx.admin });

    // Compute config_id the same way the contract does
    const sampleAction = token.methods.transfer_in_private(ctx.admin, ctx.admin, 1n, 0);
    const sampleCall = await sampleAction.getFunctionCall();

    configId = await poseidon2Hash([
      sampleCall.to.toField(),
      sampleCall.selector.toField(),
      new Fr(CONFIG_INDEX),
    ]);

    const authwit = await ctx.wallet.createAuthWit(ctx.admin, {
      caller: ctx.fpc.address,
      call: sampleCall,
    });

    const calibrated = await ctx.fpc.helpers.calibrate({
      adminWallet: ctx.wallet,
      adminAddress: ctx.admin,
      sampleCall,
      authWitnesses: [authwit],
    });
    gasLimits = { daGas: calibrated.daGas, l2Gas: calibrated.l2Gas };
    hasPublicCall = calibrated.hasPublicCall;
    const subscribeTotal = new Gas(gasLimits.daGas, gasLimits.l2Gas).add(
      fpcSubscribeOverhead(hasPublicCall),
    );
    const currentFees = await ctx.node.getCurrentMinFees();
    const maxFee = subscribeTotal.computeFee(currentFees.mul(50)).toBigInt();

    await ctx.fpc.methods
      .sign_up(sampleCall.to, sampleCall.selector, CONFIG_INDEX, MAX_USES, maxFee, MAX_USERS)
      .send({ from: ctx.admin, additionalScopes: [ctx.fpc.address] });
  });

  it("returns full slot count after sign_up", async () => {
    const { result } = await ctx.fpc.contract.methods
      .count_available_slots(configId)
      .simulate({ from: ctx.fpc.address });

    expect(result).toBe(BigInt(MAX_USERS));
  });

  it("returns (false, 0) for a user that hasn't subscribed", async () => {
    const { result } = await ctx.fpc.contract.methods
      .get_subscription_info(ctx.admin, configId)
      .simulate({ from: ctx.admin });

    expect(result[0]).toBe(false);
    expect(result[1]).toBe(0n);
  });

  it("decrements slots and creates subscription after subscribe", async () => {
    // Create a user and subscribe
    const userWallet = ctx.userWallet;
    await userWallet.registerContract(ctx.fpcInstance, SubscriptionFPC.artifact, ctx.fpcSecretKey);

    const tokenInstance = await ctx.node.getContract(token.address);
    await userWallet.registerContract(tokenInstance!, TokenContractArtifact);

    const userSecret = Fr.random();
    const userAccountManager = await ctx.wallet.createECDSARAccount(
      userSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    const userAddress = userAccountManager.address;
    await (await userAccountManager.getDeployMethod()).send({ from: ctx.admin });
    await userWallet.createECDSARAccount(userSecret, SALT, SIGNING_PRIVATE_KEY);

    // Mint tokens and register sender
    await token.methods.mint_to_private(userAddress, 1000n).send({ from: ctx.admin });
    await userWallet.registerSender(ctx.admin, "admin");

    // Subscribe
    const userToken = TokenContract.at(token.address, userWallet);
    const fpc = ctx.fpc.withWallet(userWallet);
    const sponsoredCall = await userToken.methods
      .transfer_in_private(userAddress, ctx.admin, 1n, 0)
      .getFunctionCall();
    const authWit = await userWallet.createAuthWit(userAddress, {
      caller: fpc.address,
      call: sponsoredCall,
    });

    await fpc.helpers.subscribe({
      call: sponsoredCall,
      configIndex: CONFIG_INDEX,
      userAddress,
      authWitnesses: [authWit],
      gasLimits,
      hasPublicCall,
    });

    // Check slots decreased by 1
    const { result: available } = await ctx.fpc.contract.methods
      .count_available_slots(configId)
      .simulate({ from: ctx.fpc.address });
    expect(available).toBe(BigInt(MAX_USERS - 1));

    // Check user has a subscription with max_uses - 1 remaining
    const { result: subInfo } = await ctx.fpc.contract.methods
      .get_subscription_info(userAddress, configId)
      .simulate({ from: userAddress });
    expect(subInfo[0]).toBe(true);
    expect(subInfo[1]).toBe(BigInt(MAX_USES - 1));
  });
});
