/**
 * Wallet + payment-method setup for deploy scripts. Builds a fresh ephemeral
 * `EmbeddedWallet`, registers the SponsoredFPC, and picks the right payment
 * method for the target network/mode.
 *
 * Node-only: pulls in `@aztec/pxe/server` + `@aztec/wallets/embedded`.
 */
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { getPXEConfig } from "@aztec/pxe/server";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { type AztecNode } from "@aztec/aztec.js/node";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { Fr } from "@aztec/foundation/curves/bn254";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee";

import { createNode } from "../node/create-node.ts";
import { parsePaymentMode } from "./cli.ts";
import { apiKeyForNetwork, type NetworkName, type PaymentMode } from "./network-config.ts";

export async function getSponsoredFPCContract() {
  return getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
}

/**
 * Builds the payment method for a given mode.
 *
 * - `sponsoredfpc`: `SponsoredFeePaymentMethod` pointing at the local-network
 *   SponsoredFPC. Used when the account has no fee juice.
 * - `feejuice`:     `undefined` — the wallet will pay out of the account's
 *   own FJ balance by default. The account must be funded beforehand.
 */
export type PaymentMethod = SponsoredFeePaymentMethod | undefined;

export function buildPaymentMethod(
  mode: PaymentMode,
  sponsoredFPCAddress: AztecAddress,
): PaymentMethod {
  if (mode === "feejuice") return undefined;
  return new SponsoredFeePaymentMethod(sponsoredFPCAddress);
}

export interface SetupWalletResult {
  node: AztecNode;
  wallet: EmbeddedWallet;
  sponsoredFPC: Awaited<ReturnType<typeof getSponsoredFPCContract>>;
  paymentMode: PaymentMode;
  paymentMethod: PaymentMethod;
}

export async function setupWallet(
  nodeUrl: string,
  network: NetworkName,
  paymentMode: PaymentMode = parsePaymentMode(network),
): Promise<SetupWalletResult> {
  const node = createNode(nodeUrl, apiKeyForNetwork(network));
  const proverEnabled = network !== "local";
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { ...getPXEConfig(), proverEnabled },
  });

  const sponsoredFPC = await getSponsoredFPCContract();
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);

  return {
    node,
    wallet,
    sponsoredFPC,
    paymentMode,
    paymentMethod: buildPaymentMethod(paymentMode, sponsoredFPC.address),
  };
}
