import type { Wallet } from "@aztec/aztec.js/wallet";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { BatchCall } from "@aztec/aztec.js/contracts";
import { Fr } from "@aztec/foundation/curves/bn254";
import type { ClaimCredentials } from "../types";

/**
 * Bootstrap claim: the first credential pays for gas via FeeJuicePaymentMethodWithClaim,
 * the rest are batch-claimed in the same tx. Use when the wallet has no fee juice.
 */
export async function claimWithBootstrap(
  wallet: Wallet,
  callerAddress: AztecAddress,
  bootstrapClaim: ClaimCredentials,
  otherClaims: ClaimCredentials[],
) {
  const fj = FeeJuiceContract.at(wallet);

  const paymentMethod = new FeeJuicePaymentMethodWithClaim(callerAddress, {
    claimAmount: BigInt(bootstrapClaim.claimAmount),
    claimSecret: Fr.fromHexString(bootstrapClaim.claimSecret),
    messageLeafIndex: BigInt(bootstrapClaim.messageLeafIndex),
  });

  if (otherClaims.length === 0) {
    // Bootstrap only — just pay for the tx, no additional claims
    const executionPayload = await paymentMethod.getExecutionPayload();
    return wallet.sendTx(executionPayload, { from: callerAddress });
  }

  const calls = otherClaims.map((c) => {
    const target = AztecAddress.fromStringUnsafe(c.recipient);
    return fj.methods.claim(
      target,
      BigInt(c.claimAmount),
      Fr.fromHexString(c.claimSecret),
      BigInt(c.messageLeafIndex),
    );
  });

  if (calls.length === 1) {
    return calls[0].send({ from: callerAddress, fee: { paymentMethod } });
  }

  const batch = new BatchCall(wallet, calls);
  return batch.send({ from: callerAddress, fee: { paymentMethod } });
}

/**
 * Batch claim: all credentials are claimed in one tx, gas paid from existing balance.
 * Use when the wallet already has fee juice.
 */
export async function claimBatch(
  wallet: Wallet,
  callerAddress: AztecAddress,
  claims: ClaimCredentials[],
) {
  const fj = FeeJuiceContract.at(wallet);

  const calls = claims.map((c) => {
    const target = AztecAddress.fromStringUnsafe(c.recipient);
    return fj.methods.claim(
      target,
      BigInt(c.claimAmount),
      Fr.fromHexString(c.claimSecret),
      BigInt(c.messageLeafIndex),
    );
  });

  if (calls.length === 1) {
    return calls[0].send({ from: callerAddress });
  }

  const batch = new BatchCall(wallet, calls);
  return batch.send({ from: callerAddress });
}
