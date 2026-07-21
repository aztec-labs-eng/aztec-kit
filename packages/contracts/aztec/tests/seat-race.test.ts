/**
 * Seat-nullifier race-condition tests — the point of the seat redesign.
 *
 * The old contract decremented a single shared SlotNote per config, so
 * concurrent subscribers all nullified the same note and only the first
 * landed. The new design gives each subscriber a distinct "seat"
 * (`0 <= seat < max_users`) claimed via a per-seat nullifier, so distinct
 * seats never contend. This suite proves:
 *   a. distinct seats don't race (two users, seats 0 & 1, proven+sent before
 *      either mines — both succeed);
 *   b. same-seat collision is the documented residual (loser fails with a
 *      duplicate-nullifier error, then retries a free seat and succeeds);
 *   c. `seat >= max_users` is rejected ("Seat out of range");
 *   d. capacity exhaustion (findFreeSeat throws + a forced taken seat fails);
 *   e. the seat picker never returns a taken seat and countAvailableSeats
 *      tracks claims.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { randomBytes } from "@aztec/foundation/crypto/random";
import { TokenContract, TokenContractArtifact } from "@aztec/noir-contracts.js/Token";

import { SubscriptionFPC } from "../lib/subscription-fpc.js";
import { findFreeSeat, countAvailableSeats } from "../lib/seat-picker.js";
import { setupTestContext, type FPCTestContext } from "./utils.js";
import { TEST_FEE_PADDING } from "@aztec-kit/common/testing";

const MAX_U128 = 2n ** 128n - 1n;
const RACE_INDEX = 700000 + Math.floor(Math.random() * 100000);
const CAP_INDEX = RACE_INDEX + 1;
const RACE_MAX_USERS = 4;
const MAX_USES = 2;
const SIGNING_PRIVATE_KEY = randomBytes(32);

let ctx: FPCTestContext;

beforeAll(async () => {
  ctx = await setupTestContext();
});

interface Subscriber {
  address: AztecAddress;
  wallet: EmbeddedWallet;
}

describe("Seat race conditions", () => {
  let token: TokenContract;
  let tokenInstance: ContractInstanceWithAddress;
  let raceConfigId: Fr;
  let capConfigId: Fr;
  let gasLimits: { daGas: number; l2Gas: number };
  let hasPublicCall: boolean;

  // Shared across tests so later tests can observe earlier claims.
  let u0: Subscriber;
  let u1: Subscriber;

  /** Creates a deployed, token-funded account with an FPC-aware wallet. */
  async function makeSubscriber(): Promise<Subscriber> {
    const secret = Fr.random();
    const salt = Fr.random();
    const am = await ctx.wallet.createECDSARAccount(secret, salt, SIGNING_PRIVATE_KEY);
    const address = am.address;
    await (await am.getDeployMethod()).send({ from: ctx.admin });
    await token.methods.mint_to_private(address, 1000n).send({ from: ctx.admin });

    const wallet = await EmbeddedWallet.create(ctx.node, { ephemeral: true });
    wallet.setMinFeePadding(TEST_FEE_PADDING);
    await wallet.createECDSARAccount(secret, salt, SIGNING_PRIVATE_KEY);
    await wallet.registerContract(ctx.fpcInstance, SubscriptionFPC.artifact);
    await wallet.registerContract(tokenInstance, TokenContractArtifact);
    await wallet.registerSender(ctx.admin, "admin");
    return { address, wallet };
  }

  /**
   * Builds and sends a subscribe for `sub` against `configIndex`. Returns the
   * send promise WITHOUT awaiting inclusion, so callers can fire several
   * concurrently. `seat` omitted => auto seat pick via the node.
   */
  function subscribeSend(
    sub: Subscriber,
    configIndex: number,
    maxUsers: number,
    seat?: number,
  ): Promise<unknown> {
    return (async () => {
      const userToken = TokenContract.at(token.address, sub.wallet);
      const call = await userToken.methods
        .transfer_in_private(sub.address, ctx.admin, 1n, 0)
        .getFunctionCall();
      const authWit = await sub.wallet.createAuthWit(sub.address, {
        caller: ctx.fpc.address,
        call,
      });
      const fpc = ctx.fpc.withWallet(sub.wallet);
      return fpc.helpers.subscribe({
        node: ctx.node,
        call,
        configIndex,
        userAddress: sub.address,
        maxUsers,
        seat,
        authWitnesses: [authWit],
        gasLimits,
        hasPublicCall,
      });
    })();
  }

  async function subscriptionInfo(sub: Subscriber, configId: Fr): Promise<[boolean, bigint]> {
    const { result } = await ctx.fpc
      .withWallet(sub.wallet)
      .contract.methods.get_subscription_info(sub.address, configId)
      .simulate({ from: sub.address });
    return [result[0] as boolean, BigInt(result[1])];
  }

  beforeAll(async () => {
    const { contract: rawToken, instance } = await TokenContract.deploy(
      ctx.wallet,
      ctx.admin,
      "SeatToken",
      "ST",
      18,
    ).send({ from: ctx.admin });
    token = rawToken;
    tokenInstance = instance;

    const sampleCall = await token.methods
      .transfer_in_private(ctx.admin, ctx.admin, 1n, 0)
      .getFunctionCall();
    raceConfigId = await poseidon2Hash([
      sampleCall.to.toField(),
      sampleCall.selector.toField(),
      new Fr(RACE_INDEX),
    ]);
    capConfigId = await poseidon2Hash([
      sampleCall.to.toField(),
      sampleCall.selector.toField(),
      new Fr(CAP_INDEX),
    ]);

    // Register two configs. max_fee = MAX_U128 so the fee gate never fires and
    // gas sizing is a non-issue for these correctness tests.
    await ctx.fpc.methods
      .sign_up(sampleCall.to, sampleCall.selector, RACE_INDEX, MAX_USES, MAX_U128, RACE_MAX_USERS)
      .send({ from: ctx.admin, additionalScopes: [ctx.fpc.address] });
    await ctx.fpc.methods
      .sign_up(sampleCall.to, sampleCall.selector, CAP_INDEX, MAX_USES, MAX_U128, 1)
      .send({ from: ctx.admin, additionalScopes: [ctx.fpc.address] });

    // Calibrate once against a fresh user's call (bootstrap-inclusive, so it
    // covers every fresh subscriber's constrained-delivery handshake).
    u0 = await makeSubscriber();
    const calibCall = await TokenContract.at(token.address, u0.wallet)
      .methods.transfer_in_private(u0.address, ctx.admin, 1n, 0)
      .getFunctionCall();
    const calibAuthwit = await ctx.wallet.createAuthWit(u0.address, {
      caller: ctx.fpc.address,
      call: calibCall,
    });
    const calibrated = await ctx.fpc.helpers.calibrate({
      adminWallet: ctx.wallet,
      adminAddress: ctx.admin,
      sampleCall: calibCall,
      authWitnesses: [calibAuthwit],
      sendMessagesAs: u0.address,
      additionalScopes: [u0.address],
    });
    gasLimits = { daGas: calibrated.daGas, l2Gas: calibrated.l2Gas };
    hasPublicCall = calibrated.hasPublicCall;
  });

  it("lets two users claim distinct seats concurrently (0 and 1)", async () => {
    u1 = await makeSubscriber();

    // Fire both before awaiting either receipt: the OLD contract fails this
    // even across blocks (both consume the same SlotNote nullifier). With
    // distinct seats the nullifiers differ, so both must land.
    const p0 = subscribeSend(u0, RACE_INDEX, RACE_MAX_USERS, 0);
    const p1 = subscribeSend(u1, RACE_INDEX, RACE_MAX_USERS, 1);
    await Promise.all([p0, p1]);

    for (const u of [u0, u1]) {
      const [has, uses] = await subscriptionInfo(u, raceConfigId);
      expect(has).toBe(true);
      expect(uses).toBe(BigInt(MAX_USES - 1));
    }
  });

  it("seat picker sees taken seats and countAvailableSeats tracks claims", async () => {
    const available = await countAvailableSeats({
      node: ctx.node,
      fpcAddress: ctx.fpc.address,
      configId: raceConfigId,
      maxUsers: RACE_MAX_USERS,
    });
    expect(available).toBe(RACE_MAX_USERS - 2); // seats 0 and 1 are taken

    // findFreeSeat must never return a taken seat (0 or 1).
    for (let i = 0; i < 10; i++) {
      const seat = await findFreeSeat({
        node: ctx.node,
        fpcAddress: ctx.fpc.address,
        configId: raceConfigId,
        maxUsers: RACE_MAX_USERS,
      });
      expect([2, 3]).toContain(seat);
    }
  });

  it("same seat collides: loser fails, then retries a free seat and succeeds", async () => {
    const u2 = await makeSubscriber();

    // Seat 0 is already claimed by u0 — forcing it reaches the node and fails
    // on the duplicate seat-ticket nullifier.
    await expect(subscribeSend(u2, RACE_INDEX, RACE_MAX_USERS, 0)).rejects.toThrow();

    // Retrying with auto seat picking skips the taken seats and succeeds.
    await subscribeSend(u2, RACE_INDEX, RACE_MAX_USERS);
    const [has, uses] = await subscriptionInfo(u2, raceConfigId);
    expect(has).toBe(true);
    expect(uses).toBe(BigInt(MAX_USES - 1));
  });

  it("rejects a seat >= max_users (Seat out of range)", async () => {
    // u0 already holds seat 0; this must fail at the bounds assert regardless.
    await expect(subscribeSend(u0, RACE_INDEX, RACE_MAX_USERS, 99)).rejects.toThrow(
      /Seat out of range/,
    );
  });

  it("exhausts a max_users=1 config: findFreeSeat throws and a forced seat fails", async () => {
    const uc = await makeSubscriber();

    // Claim the single seat.
    await subscribeSend(uc, CAP_INDEX, 1);
    const [has] = await subscriptionInfo(uc, capConfigId);
    expect(has).toBe(true);

    // No seats left: the picker throws the all-taken error.
    await expect(
      findFreeSeat({
        node: ctx.node,
        fpcAddress: ctx.fpc.address,
        configId: capConfigId,
        maxUsers: 1,
      }),
    ).rejects.toThrow(/seats for this config are taken/);

    expect(
      await countAvailableSeats({
        node: ctx.node,
        fpcAddress: ctx.fpc.address,
        configId: capConfigId,
        maxUsers: 1,
      }),
    ).toBe(0);

    // Forcing the taken seat 0 fails on the duplicate nullifier.
    await expect(subscribeSend(u0, CAP_INDEX, 1, 0)).rejects.toThrow();
  });
});
