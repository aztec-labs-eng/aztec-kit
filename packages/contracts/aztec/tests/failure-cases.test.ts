import { describe, it, expect, beforeAll } from "vitest";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { Gas } from "@aztec/stdlib/gas";
import { randomBytes } from "@aztec/foundation/crypto/random";
import { TokenContract, TokenContractArtifact } from "@aztec/noir-contracts.js/Token";

import { SubscriptionFPC, fpcSubscribeOverhead } from "../lib/subscription-fpc.js";
import { GrieferWallet } from "./utils.js";
import { setupTestContext, type FPCTestContext } from "./utils.js";
import { TEST_FEE_PADDING } from "@aztec-kit/common/testing";

const FAILURE_INDEX = 200000 + Math.floor(Math.random() * 100000);
const SALT = Fr.random();
const SIGNING_PRIVATE_KEY = randomBytes(32);

let ctx: FPCTestContext;

beforeAll(async () => {
  ctx = await setupTestContext();
});

describe("Failure cases", () => {
  let userWallet: EmbeddedWallet;
  let token: TokenContract;
  let userAddress: AztecAddress;
  let recipientAddress: AztecAddress;
  let gasLimits: { daGas: number; l2Gas: number };
  let hasPublicCall: boolean;

  beforeAll(async () => {
    const { contract: rawToken, instance: tokenInstance } = await TokenContract.deploy(
      ctx.wallet,
      ctx.admin,
      "FailToken",
      "FT",
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
    await (await userAccountManager.getDeployMethod()).send({ from: ctx.admin });
    await userWallet.createECDSARAccount(userSecret, SALT, SIGNING_PRIVATE_KEY);

    const recipientSecret = await Fr.random();
    const recipientAccountManager = await ctx.wallet.createECDSARAccount(
      recipientSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    recipientAddress = recipientAccountManager.address;
    await (await recipientAccountManager.getDeployMethod()).send({ from: ctx.admin });
    await userWallet.createECDSARAccount(recipientSecret, SALT, SIGNING_PRIVATE_KEY);

    await token.methods.mint_to_private(userAddress, 1000n).send({ from: ctx.admin });
    await token.methods.mint_to_private(ctx.admin, 1000n).send({ from: ctx.admin });
    await userWallet.registerSender(ctx.admin, "admin");

    // Set up a sponsored app with max_uses=1, max_users=1
    const sampleAction = token.methods.transfer_in_private(ctx.admin, recipientAddress, 1n, 0);
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
    gasLimits = { daGas: calibrated.daGas, l2Gas: calibrated.l2Gas };
    hasPublicCall = calibrated.hasPublicCall;
    // Size max_fee against the subscribe-path composite with a 50× safety
    // multiplier.
    const subscribeTotal = new Gas(gasLimits.daGas, gasLimits.l2Gas).add(
      fpcSubscribeOverhead(hasPublicCall),
    );
    const currentFees = await ctx.node.getCurrentMinFees();
    const maxFee = subscribeTotal.computeFee(currentFees.mul(50)).toBigInt();

    await ctx.fpc.methods
      .sign_up(sampleCall.to, sampleCall.selector, FAILURE_INDEX, 1, maxFee, 1)
      .send({ from: ctx.admin });

    // Subscribe — consumes the only slot and the only use
    const userToken = TokenContract.at(token.address, userWallet);
    const subscribeCall = await userToken.methods
      .transfer_in_private(userAddress, recipientAddress, 1n, 0)
      .getFunctionCall();
    const subscribeAuthWit = await userWallet.createAuthWit(userAddress, {
      caller: ctx.fpc.address,
      call: subscribeCall,
    });

    const fpc = ctx.fpc.withWallet(userWallet);
    await fpc.helpers.subscribe({
      call: subscribeCall,
      configIndex: FAILURE_INDEX,
      userAddress,
      authWitnesses: [subscribeAuthWit],
      gasLimits,
      hasPublicCall,
    });
  });

  it("rejects sponsor call when subscription uses are exhausted", async () => {
    const userToken = TokenContract.at(token.address, userWallet);
    const fpc = ctx.fpc.withWallet(userWallet);

    const sponsoredCall = await userToken.methods
      .transfer_in_private(userAddress, recipientAddress, 1n, 0)
      .getFunctionCall();

    const authWit = await userWallet.createAuthWit(userAddress, {
      caller: ctx.fpc.address,
      call: sponsoredCall,
    });

    await expect(
      fpc.helpers.sponsor({
        call: sponsoredCall,
        configIndex: FAILURE_INDEX,
        userAddress,
        authWitnesses: [authWit],
        gasLimits,
        hasPublicCall,
      }),
    ).rejects.toThrow();
  });

  it("fails in simulation when no slots are available", async () => {
    const grieferWallet = await GrieferWallet.create(ctx.node, {
      ephemeral: true,
    });
    grieferWallet.setMinFeePadding(TEST_FEE_PADDING);
    await grieferWallet.registerContract(
      ctx.fpcInstance,
      SubscriptionFPC.artifact,
      ctx.fpcSecretKey,
    );
    await grieferWallet.registerContract(
      (await ctx.node.getContract(token.address))!,
      TokenContractArtifact,
    );

    const grieferSecret = await Fr.random();
    const grieferAccountManager = await ctx.wallet.createECDSARAccount(
      grieferSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    const grieferAddress = grieferAccountManager.address;
    await (await grieferAccountManager.getDeployMethod()).send({ from: ctx.admin });
    await grieferWallet.createECDSARAccount(grieferSecret, SALT, SIGNING_PRIVATE_KEY);

    const grieferToken = TokenContract.at(token.address, grieferWallet);
    const griefCall = await grieferToken.methods
      .transfer_in_private(grieferAddress, recipientAddress, 1n, 0)
      .getFunctionCall();

    const griefAuthWit = await grieferWallet.createAuthWit(grieferAddress, {
      caller: ctx.fpc.address,
      call: griefCall,
    });

    const fpc = ctx.fpc.withWallet(grieferWallet);

    await expect(
      fpc.helpers.subscribe({
        call: griefCall,
        configIndex: FAILURE_INDEX,
        userAddress: grieferAddress,
        authWitnesses: [griefAuthWit],
        gasLimits,
        hasPublicCall,
      }),
    ).rejects.toThrow();
  });

  it("rejects subscribe when gas settings would exceed max_fee", async () => {
    // Sign up a fresh slot with an absurdly low max_fee (1 juice). Any realistic
    // tx exceeds this, so the setup-phase gate in subscribe() must reject
    // before the FPC commits as fee payer.
    const TIGHT_INDEX = FAILURE_INDEX + 1;

    const tightUserWallet = ctx.userWallet;
    await tightUserWallet.registerContract(
      ctx.fpcInstance,
      SubscriptionFPC.artifact,
      ctx.fpcSecretKey,
    );
    await tightUserWallet.registerContract(
      (await ctx.node.getContract(token.address))!,
      TokenContractArtifact,
    );

    const tightUserSecret = await Fr.random();
    const tightUserAccountManager = await ctx.wallet.createECDSARAccount(
      tightUserSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    const tightUserAddress = tightUserAccountManager.address;
    await (await tightUserAccountManager.getDeployMethod()).send({ from: ctx.admin });
    await tightUserWallet.createECDSARAccount(tightUserSecret, SALT, SIGNING_PRIVATE_KEY);

    const tightUserToken = TokenContract.at(token.address, tightUserWallet);
    const tightCall = await tightUserToken.methods
      .transfer_in_private(tightUserAddress, recipientAddress, 1n, 0)
      .getFunctionCall();

    await ctx.fpc.methods
      .sign_up(
        /*app=*/ tightCall.to,
        /*selector=*/ tightCall.selector,
        /*current_index=*/ TIGHT_INDEX,
        /*max_uses=*/ 1,
        /*max_fee=*/ 1n, // VERY LOW MAX FEE
        /*max_users=*/ 1,
      )
      .send({ from: ctx.admin });

    const tightAuthWit = await tightUserWallet.createAuthWit(tightUserAddress, {
      caller: ctx.fpc.address,
      call: tightCall,
    });

    const fpc = ctx.fpc.withWallet(tightUserWallet);

    await expect(
      fpc.helpers.subscribe({
        call: tightCall,
        configIndex: TIGHT_INDEX,
        userAddress: tightUserAddress,
        authWitnesses: [tightAuthWit],
        gasLimits,
        hasPublicCall,
      }),
    ).rejects.toThrow(/Gas settings exceed subscription max_fee/);
  });
});
