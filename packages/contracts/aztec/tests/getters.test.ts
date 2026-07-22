/**
 * Tests for the FPC getters:
 * - countAvailableSeats (TS): remaining free seats for a config, via a node
 *   scan of the nullifier tree (replaces the deleted count_available_slots
 *   contract utility).
 * - get_config (utility): returns the config's {max_fee, max_uses, max_users}.
 * - compute_seat_nullifier (utility): pins TS<->Noir seat-nullifier parity.
 * - get_subscription_info (utility): (has_subscription, remaining_uses) per user.
 *
 * Creates a subscription config with 100 seats, subscribes a user, and verifies
 * the getters return correct values throughout.
 */

import { describe, it, expect, beforeAll } from "vitest";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { Gas } from "@aztec/stdlib/gas";
import { randomBytes } from "@aztec/foundation/crypto/random";
import { TokenContract, TokenContractArtifact } from "@aztec/noir-contracts.js/Token";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

import { SubscriptionFPC, fpcSubscribeOverhead } from "../lib/subscription-fpc.js";
import { countAvailableSeats, computeSeatNullifier } from "../lib/seat-picker.js";
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
  let userSecret: Fr;
  let userAddress: AztecAddress;

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

    // Create the user that will subscribe later. Calibration must measure
    // the call the SUBSCRIBER will make, in the subscriber's state: the
    // token's constrained note delivery pays a one-time handshake bootstrap
    // per fresh (sender → recipient) chain, so a first-time user's transfer
    // costs more than the same transfer on established chains. Calibrating
    // the admin's own call instead would underfund the user's subscribe.
    userSecret = Fr.random();
    const userAccountManager = await ctx.wallet.createECDSARAccount(
      userSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    userAddress = userAccountManager.address;
    await (await userAccountManager.getDeployMethod()).send({ from: ctx.admin });

    // Mint tokens to the user for calibration + the sponsored transfer
    await token.methods.mint_to_private(userAddress, 1000n).send({ from: ctx.admin });

    // Compute config_id the same way the contract does
    const sampleAction = token.methods.transfer_in_private(userAddress, ctx.admin, 1n, 0);
    const sampleCall = await sampleAction.getFunctionCall();

    configId = await poseidon2Hash([
      sampleCall.to.toField(),
      sampleCall.selector.toField(),
      new Fr(CONFIG_INDEX),
    ]);

    const authwit = await ctx.wallet.createAuthWit(userAddress, {
      caller: ctx.fpc.address,
      call: sampleCall,
    });

    const calibrated = await ctx.fpc.helpers.calibrate({
      adminWallet: ctx.wallet,
      adminAddress: ctx.admin,
      sampleCall,
      authWitnesses: [authwit],
      sendMessagesAs: userAddress,
      additionalScopes: [userAddress],
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

  it("returns full seat count after sign_up", async () => {
    const available = await countAvailableSeats({
      node: ctx.node,
      fpcAddress: ctx.fpc.address,
      configId,
      maxUsers: MAX_USERS,
    });

    expect(available).toBe(MAX_USERS);
  });

  it("get_config returns the signed-up config parameters", async () => {
    const { result } = await ctx.fpc.contract.methods
      .get_config(configId)
      .simulate({ from: ctx.fpc.address });

    expect(result.max_uses).toBe(BigInt(MAX_USES));
    expect(result.max_users).toBe(BigInt(MAX_USERS));
    expect(result.max_fee).toBeGreaterThan(0n);
  });

  it("compute_seat_nullifier matches the TS computeSeatNullifier (hash parity)", async () => {
    for (const seat of [0, 1, 42, MAX_USERS - 1]) {
      const { result: onchainInner } = await ctx.fpc.contract.methods
        .compute_seat_nullifier(configId, seat)
        .simulate({ from: ctx.fpc.address });
      const tsInner = await computeSeatNullifier(configId, seat);
      expect(new Fr(onchainInner).toString()).toBe(tsInner.toString());
    }
  });

  it("returns (false, 0) for a user that hasn't subscribed", async () => {
    const { result } = await ctx.fpc.contract.methods
      .get_subscription_info(ctx.admin, configId)
      .simulate({ from: ctx.admin });

    expect(result[0]).toBe(false);
    expect(result[1]).toBe(0n);
  });

  it("decrements slots and creates subscription after subscribe", async () => {
    // Subscribe with the user created (and calibrated for) in beforeAll
    const userWallet = ctx.userWallet;
    await userWallet.registerContract(ctx.fpcInstance, SubscriptionFPC.artifact);

    const tokenInstance = await ctx.node.getContract(token.address);
    await userWallet.registerContract(tokenInstance!, TokenContractArtifact);

    await userWallet.createECDSARAccount(userSecret, SALT, SIGNING_PRIVATE_KEY);
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
      node: ctx.node,
      call: sponsoredCall,
      configIndex: CONFIG_INDEX,
      userAddress,
      maxUsers: MAX_USERS,
      authWitnesses: [authWit],
      gasLimits,
      hasPublicCall,
    });

    // Check available seats decreased by 1
    const available = await countAvailableSeats({
      node: ctx.node,
      fpcAddress: ctx.fpc.address,
      configId,
      maxUsers: MAX_USERS,
    });
    expect(available).toBe(MAX_USERS - 1);

    // Check user has a subscription with max_uses - 1 remaining
    const { result: subInfo } = await ctx.fpc.contract.methods
      .get_subscription_info(userAddress, configId)
      .simulate({ from: userAddress });
    expect(subInfo[0]).toBe(true);
    expect(subInfo[1]).toBe(BigInt(MAX_USES - 1));
  });
});
