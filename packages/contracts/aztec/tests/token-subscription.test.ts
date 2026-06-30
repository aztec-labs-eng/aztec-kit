import { describe, it, expect, beforeAll } from "vitest";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { Gas } from "@aztec/stdlib/gas";
import { randomBytes } from "@aztec/foundation/crypto/random";
import { TokenContract, TokenContractArtifact } from "@aztec/noir-contracts.js/Token";

import { SetPublicAuthwitContractInteraction } from "@aztec/aztec.js/authorization";

import { SubscriptionFPC, fpcSubscribeOverhead } from "../lib/subscription-fpc.js";
import { setupTestContext, type FPCTestContext } from "./utils.js";

const PRIVATE_INDEX = 100000 + Math.floor(Math.random() * 100000);
const PUBLIC_INDEX = PRIVATE_INDEX + 1;
const MAX_USES = 4;
const MAX_USERS = 10;
const SALT = Fr.random();
const SIGNING_PRIVATE_KEY = randomBytes(32);

let ctx: FPCTestContext;

beforeAll(async () => {
  ctx = await setupTestContext();
});

describe("Token transfer subscription (multi-use)", () => {
  let userWallet: EmbeddedWallet;
  let token: TokenContract;
  let userAddress: AztecAddress;
  let recipientAddress: AztecAddress;
  let privateGasLimits: { daGas: number; l2Gas: number };
  let privateHasPublicCall: boolean;

  beforeAll(async () => {
    const { contract: rawToken, instance: tokenInstance } = await TokenContract.deploy(
      ctx.wallet,
      ctx.admin,
      "TestToken",
      "TT",
      18,
    ).send({
      from: ctx.admin,
    });
    token = rawToken;

    userWallet = ctx.userWallet;

    await userWallet.registerContract(ctx.fpcInstance, SubscriptionFPC.artifact, ctx.fpcSecretKey);
    await userWallet.registerContract(tokenInstance, TokenContractArtifact);

    const userSecret = await Fr.random();
    const userAccountManager = await ctx.wallet.createECDSARAccount(
      userSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    userAddress = userAccountManager.address;
    const userDeployMethod = await userAccountManager.getDeployMethod();
    await userDeployMethod.send({ from: ctx.admin });

    await userWallet.createECDSARAccount(userSecret, SALT, SIGNING_PRIVATE_KEY);

    const recipientSecret = await Fr.random();
    const recipientAccountManager = await ctx.wallet.createECDSARAccount(
      recipientSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    recipientAddress = recipientAccountManager.address;
    const recipientDeployMethod = await recipientAccountManager.getDeployMethod();
    await recipientDeployMethod.send({ from: ctx.admin });

    await userWallet.createECDSARAccount(recipientSecret, SALT, SIGNING_PRIVATE_KEY);

    await token.methods.mint_to_private(ctx.admin, 1000n).send({ from: ctx.admin });
    await token.methods.mint_to_private(userAddress, 1000n).send({ from: ctx.admin });

    await userWallet.registerSender(ctx.admin, "admin");
  });

  it("calibrates and sets up transfer_in_private as a sponsored app", async () => {
    const sampleAction = token.methods.transfer_in_private(ctx.admin, recipientAddress, 10n, 0);
    const sampleCall = await sampleAction.getFunctionCall();

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
    privateGasLimits = { daGas: calibrated.daGas, l2Gas: calibrated.l2Gas };
    privateHasPublicCall = calibrated.hasPublicCall;
    const subscribeTotal = new Gas(privateGasLimits.daGas, privateGasLimits.l2Gas).add(
      fpcSubscribeOverhead(privateHasPublicCall),
    );
    const currentFees = await ctx.node.getCurrentMinFees();
    const maxFee = subscribeTotal.computeFee(currentFees.mul(50)).toBigInt();
    expect(maxFee).toBeGreaterThan(0n);

    await ctx.fpc.methods
      .sign_up(sampleCall.to, sampleCall.selector, PRIVATE_INDEX, MAX_USES, maxFee, MAX_USERS)
      .send({ from: ctx.admin, additionalScopes: [ctx.fpc.address] });
  });

  it("subscribes and makes a sponsored transfer_in_private", async () => {
    const userToken = TokenContract.at(token.address, userWallet);
    const fpc = ctx.fpc.withWallet(userWallet);

    const sponsoredCall = await userToken.methods
      .transfer_in_private(userAddress, recipientAddress, 10n, 0)
      .getFunctionCall();

    const authWit = await userWallet.createAuthWit(userAddress, {
      caller: fpc.address,
      call: sponsoredCall,
    });

    await fpc.helpers.subscribe({
      call: sponsoredCall,
      configIndex: PRIVATE_INDEX,
      userAddress,
      authWitnesses: [authWit],
      gasLimits: privateGasLimits,
      hasPublicCall: privateHasPublicCall,
    });
  });

  it("uses the subscription for a second sponsored transfer", async () => {
    const userToken = TokenContract.at(token.address, userWallet);
    const fpc = ctx.fpc.withWallet(userWallet);

    const sponsoredCall = await userToken.methods
      .transfer_in_private(userAddress, recipientAddress, 15n, 0)
      .getFunctionCall();

    const authWit = await userWallet.createAuthWit(userAddress, {
      caller: fpc.address,
      call: sponsoredCall,
    });
    await fpc.helpers.sponsor({
      call: sponsoredCall,
      configIndex: PRIVATE_INDEX,
      userAddress,
      authWitnesses: [authWit],
      gasLimits: privateGasLimits,
      hasPublicCall: privateHasPublicCall,
    });
  });

  it("verifies recipient received all transfers", async () => {
    const userToken = TokenContract.at(token.address, userWallet);

    const { result: recipientBalance } = await userToken.methods
      .balance_of_private(recipientAddress)
      .simulate({ from: recipientAddress });

    expect(recipientBalance).toBe(25n);

    const { result: userBalance } = await userToken.methods
      .balance_of_private(userAddress)
      .simulate({ from: userAddress });

    expect(userBalance).toBe(975n);
  });
});

// ─── Public Transfer Subscription ───────────────────────────────────────────

describe("Public token transfer subscription", () => {
  let token: TokenContract;
  let publicGasLimits: { daGas: number; l2Gas: number };
  let publicHasPublicCall: boolean;

  beforeAll(async () => {
    const { contract: rawToken } = await TokenContract.deploy(
      ctx.wallet,
      ctx.admin,
      "PublicToken",
      "PT",
      18,
    ).send({
      from: ctx.admin,
    });
    token = rawToken;

    // Mint public tokens to admin
    await token.methods.mint_to_public(ctx.admin, 100000n).send({ from: ctx.admin });
  });

  it("calibrates and sets up transfer_in_public as a sponsored app", async () => {
    const action = token.methods.transfer_in_public(ctx.admin, ctx.admin, 10n, 0n);

    // Set public authwit for calibration (FPC is the caller)
    const setAuthwit = await SetPublicAuthwitContractInteraction.create(
      ctx.wallet,
      ctx.admin,
      { caller: ctx.fpc.address, action },
      true,
    );
    await setAuthwit.send();

    const sampleCall = await action.getFunctionCall();

    const calibrated = await ctx.fpc.helpers.calibrate({
      adminWallet: ctx.wallet,
      adminAddress: ctx.admin,
      sampleCall,
    });
    publicGasLimits = { daGas: calibrated.daGas, l2Gas: calibrated.l2Gas };
    publicHasPublicCall = calibrated.hasPublicCall;
    const subscribeTotal = new Gas(publicGasLimits.daGas, publicGasLimits.l2Gas).add(
      fpcSubscribeOverhead(publicHasPublicCall),
    );
    const currentFees = await ctx.node.getCurrentMinFees();
    const maxFee = subscribeTotal.computeFee(currentFees.mul(50)).toBigInt();
    expect(maxFee).toBeGreaterThan(0n);

    await ctx.fpc.methods
      .sign_up(sampleCall.to, sampleCall.selector, PUBLIC_INDEX, 2, maxFee, 1)
      .send({ from: ctx.admin, additionalScopes: [ctx.fpc.address] });
  });

  it("subscribes and makes a sponsored transfer_in_public", async () => {
    const authwitNonce = Fr.random();
    const action = token.methods.transfer_in_public(ctx.admin, ctx.admin, 10n, authwitNonce);

    const setAuthwit = await SetPublicAuthwitContractInteraction.create(
      ctx.wallet,
      ctx.admin,
      { caller: ctx.fpc.address, action },
      true,
    );
    await setAuthwit.send();

    const sampleCall = await action.getFunctionCall();
    const fpc = ctx.fpc.withWallet(ctx.wallet);

    await fpc.helpers.subscribe({
      call: sampleCall,
      configIndex: PUBLIC_INDEX,
      userAddress: ctx.admin,
      gasLimits: publicGasLimits,
      hasPublicCall: publicHasPublicCall,
    });
  });

  it("uses the subscription for a sponsored transfer_in_public", async () => {
    const authwitNonce = Fr.random();
    const action = token.methods.transfer_in_public(ctx.admin, ctx.admin, 5n, authwitNonce);

    const setAuthwit = await SetPublicAuthwitContractInteraction.create(
      ctx.wallet,
      ctx.admin,
      { caller: ctx.fpc.address, action },
      true,
    );
    await setAuthwit.send();

    const sampleCall = await action.getFunctionCall();
    const fpc = ctx.fpc.withWallet(ctx.wallet);

    await fpc.helpers.sponsor({
      call: sampleCall,
      configIndex: PUBLIC_INDEX,
      userAddress: ctx.admin,
      gasLimits: publicGasLimits,
      hasPublicCall: publicHasPublicCall,
    });
  });
});
