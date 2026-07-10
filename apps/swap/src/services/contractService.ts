/**
 * Contract Service
 * Pure functions for contract-related operations
 */

import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AztecNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { AztecAddress as AztecAddressClass } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { ContractArtifact } from "@aztec/aztec.js/abi";
import { FunctionSelector } from "@aztec/aztec.js/abi";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import {
  BatchCall,
  getContractInstanceFromInstantiationParams,
  type OffchainMessage,
} from "@aztec/aztec.js/contracts";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import type { TxReceipt } from "@aztec/stdlib/tx";
import type { TokenContract } from "@aztec/noir-contracts.js/Token";
import type { AMMContract } from "@aztec-kit/contracts-aztec/artifacts/AMM";
import type { ProofOfPasswordContract } from "@aztec-kit/contracts-aztec/artifacts/ProofOfPassword";
import { SubscriptionFPC } from "@aztec-kit/contracts-aztec/subscription-fpc";
import { BigDecimal } from "../utils/bigDecimal";
import type { NetworkConfig } from "../config/networks";
import type { OnboardingResult } from "../contexts/onboarding/reducer";

/**
 * Contracts returned after swap registration
 */
export interface SwapContracts {
  goCoin: TokenContract;
  goCoinPremium: TokenContract;
  amm: AMMContract;
  fpc: SubscriptionFPC | null;
}

/**
 * Contracts returned after drip registration
 */
export interface DripContracts {
  pop: ProofOfPasswordContract;
  fpc: SubscriptionFPC | null;
}

/**
 * Registers contracts needed for the swap flow
 * Returns the contract instances after registration
 * Skips registration for contracts that are already registered
 */
export async function registerSwapContracts(
  wallet: Wallet,
  node: AztecNode,
  network: NetworkConfig,
): Promise<SwapContracts> {
  const goCoinAddress = AztecAddressClass.fromStringUnsafe(network.contracts.goCoin);
  const goCoinPremiumAddress = AztecAddressClass.fromStringUnsafe(network.contracts.goCoinPremium);
  const liquidityTokenAddress = AztecAddressClass.fromStringUnsafe(
    network.contracts.liquidityToken,
  );
  const ammAddress = AztecAddressClass.fromStringUnsafe(network.contracts.amm);
  const deployerAddress = AztecAddressClass.fromStringUnsafe(network.deployer.address);
  const contractSalt = Fr.fromString(network.contracts.salt);

  // Import contract artifacts
  const { TokenContract, TokenContractArtifact } = await import("@aztec/noir-contracts.js/Token");
  const { AMMContract, AMMContractArtifact } =
    await import("@aztec-kit/contracts-aztec/artifacts/AMM");

  // Determine subscription FPC for sponsored swaps
  const subFPC = network.subscriptionFPC;
  const fpcAddress = subFPC ? AztecAddressClass.fromStringUnsafe(subFPC.address) : undefined;

  // Check which contracts are already registered
  const metadataChecks: { name: "getContractMetadata"; args: [AztecAddress] }[] = [
    { name: "getContractMetadata", args: [ammAddress] },
    { name: "getContractMetadata", args: [goCoinAddress] },
    { name: "getContractMetadata", args: [goCoinPremiumAddress] },
  ];
  if (fpcAddress) {
    metadataChecks.push({ name: "getContractMetadata", args: [fpcAddress] });
  }
  const metadataResults = await wallet.batch(metadataChecks);
  const [ammMetadata, goCoinMetadata, goCoinPremiumMetadata] = metadataResults;

  // Reconstruct contract instances for unregistered contracts
  const [ammInstance, goCoinInstance, goCoinPremiumInstance] = await Promise.all([
    !ammMetadata.result.instance
      ? getContractInstanceFromInstantiationParams(AMMContractArtifact, {
          salt: contractSalt,
          deployer: deployerAddress,
          constructorArgs: [goCoinAddress, goCoinPremiumAddress, liquidityTokenAddress],
        })
      : null,
    !goCoinMetadata.result.instance
      ? getContractInstanceFromInstantiationParams(TokenContractArtifact, {
          salt: contractSalt,
          deployer: deployerAddress,
          constructorArgs: [deployerAddress, "GoCoin", "GO", 18],
        })
      : null,
    !goCoinPremiumMetadata.result.instance
      ? getContractInstanceFromInstantiationParams(TokenContractArtifact, {
          salt: contractSalt,
          deployer: deployerAddress,
          constructorArgs: [deployerAddress, "GoCoinPremium", "GOP", 18],
        })
      : null,
  ]);

  // Build registration batch for unregistered contracts only
  const registrationBatch: {
    name: "registerContract";
    args: [ContractInstanceWithAddress, ContractArtifact, Fr | undefined];
  }[] = [];

  if (ammInstance) {
    registrationBatch.push({
      name: "registerContract",
      args: [ammInstance, AMMContractArtifact, undefined],
    });
  }
  if (goCoinInstance) {
    registrationBatch.push({
      name: "registerContract",
      args: [goCoinInstance, TokenContractArtifact, undefined],
    });
  }
  if (goCoinPremiumInstance) {
    // goCoinPremium shares the same artifact as goCoin, so we can omit it
    registrationBatch.push({
      name: "registerContract",
      args: [goCoinPremiumInstance, undefined, undefined],
    });
  }

  // Register subscription FPC for sponsored swaps (if configured and not yet registered)
  if (subFPC && fpcAddress) {
    const fpcMetadata = metadataResults[3];
    if (!fpcMetadata?.result?.instance) {
      const instance = await node.getContract(fpcAddress);
      if (!instance) {
        throw new Error(`Subscription FPC at ${subFPC.address} not found on-chain`);
      }
      const secretKey = Fr.fromString(subFPC.secretKey);
      const { SubscriptionFPCContractArtifact } =
        await import("@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC");
      registrationBatch.push({
        name: "registerContract",
        args: [instance, SubscriptionFPCContractArtifact, secretKey],
      });
    }
  }

  // Only call batch if there are contracts to register
  if (registrationBatch.length > 0) {
    await wallet.batch(registrationBatch);
  }

  // Instantiate the contracts
  const goCoin = TokenContract.at(goCoinAddress, wallet);
  const goCoinPremium = TokenContract.at(goCoinPremiumAddress, wallet);
  const amm = AMMContract.at(ammAddress, wallet);

  // Instantiate FPC wrapper if configured
  const fpc = subFPC && fpcAddress ? SubscriptionFPC.at(fpcAddress, wallet) : null;

  return { goCoin, goCoinPremium, amm, fpc };
}

/**
 * Registers contracts needed for the drip flow
 * Returns the contract instances after registration
 * Skips registration for contracts that are already registered
 */
export async function registerDripContracts(
  wallet: Wallet,
  node: AztecNode,
  network: NetworkConfig,
): Promise<DripContracts> {
  const popAddress = AztecAddressClass.fromStringUnsafe(network.contracts.pop);

  const { ProofOfPasswordContract, ProofOfPasswordContractArtifact } =
    await import("@aztec-kit/contracts-aztec/artifacts/ProofOfPassword");

  // Determine which FPC to use: subscription FPC (preferred) or fallback to Aztec's sponsored FPC
  const subFPC = network.subscriptionFPC;

  // Check which contracts are already registered
  const metadataChecks: { name: "getContractMetadata"; args: [AztecAddress] }[] = [
    { name: "getContractMetadata", args: [popAddress] },
  ];
  if (subFPC) {
    metadataChecks.push({
      name: "getContractMetadata",
      args: [AztecAddressClass.fromStringUnsafe(subFPC.address)],
    });
  }

  const metadataResults = await wallet.batch(metadataChecks);
  const popMetadata = metadataResults[0];

  // Build registration batch for unregistered contracts only
  const registrationBatch: {
    name: "registerContract";
    args: [ContractInstanceWithAddress, ContractArtifact, Fr | undefined];
  }[] = [];

  if (!popMetadata.result.instance) {
    const instance = await node.getContract(popAddress);
    registrationBatch.push({
      name: "registerContract",
      args: [instance, ProofOfPasswordContractArtifact, undefined],
    });
  }

  // Register subscription FPC if configured and not yet registered
  if (!subFPC) {
    throw new Error("No subscriptionFPC configured for this network");
  }
  const subFPCMetadata = metadataResults[1];
  if (!subFPCMetadata.result.instance) {
    const fpcAddress = AztecAddressClass.fromStringUnsafe(subFPC.address);
    const secretKey = Fr.fromString(subFPC.secretKey);
    const instance = await node.getContract(fpcAddress);
    if (!instance) {
      throw new Error(`Subscription FPC at ${subFPC.address} not found on-chain`);
    }
    const { SubscriptionFPCContractArtifact } =
      await import("@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC");
    registrationBatch.push({
      name: "registerContract",
      args: [instance, SubscriptionFPCContractArtifact, secretKey],
    });
  }

  // Only call batch if there are contracts to register
  if (registrationBatch.length > 0) {
    await wallet.batch(registrationBatch);
  }

  // Instantiate the ProofOfPassword contract
  const pop = ProofOfPasswordContract.at(popAddress, wallet);

  // Instantiate FPC wrapper if configured
  const fpcAddr = subFPC ? AztecAddressClass.fromStringUnsafe(subFPC.address) : undefined;
  const fpc = fpcAddr ? SubscriptionFPC.at(fpcAddr, wallet) : null;

  return { pop, fpc };
}

/**
 * Gets the current exchange rate from the AMM
 */
export async function getExchangeRate(
  wallet: Wallet,
  contracts: SwapContracts,
  fromAddress: AztecAddress,
): Promise<number> {
  const { goCoin, goCoinPremium, amm } = contracts;

  const batchCall = new BatchCall(wallet, [
    goCoin.methods.balance_of_public(amm.address),
    goCoinPremium.methods.balance_of_public(amm.address),
  ]);

  const { result } = await batchCall.simulate({ from: fromAddress });
  const token0Reserve = result[0].result;
  const token1Reserve = result[1].result;
  return parseFloat(new BigDecimal(token1Reserve).divide(new BigDecimal(token0Reserve)).toString());
}

/**
 * Fetches balances for a given address
 */
export async function fetchBalances(
  wallet: Wallet,
  contracts: SwapContracts,
  address: AztecAddress,
): Promise<[bigint, bigint]> {
  const { goCoin, goCoinPremium } = contracts;

  const batchCall = new BatchCall(wallet, [
    goCoin.methods.balance_of_private(address),
    goCoinPremium.methods.balance_of_private(address),
  ]);

  const { result } = await batchCall.simulate({ from: address });
  return [result[0].result, result[1].result];
}

/**
 * Simulates onboarding queries to get exchange rate and balances
 * This triggers wallet approval for these queries, so future reads are seamless
 */
export async function simulateOnboardingQueries(
  wallet: Wallet,
  contracts: SwapContracts,
  address: AztecAddress,
): Promise<OnboardingResult> {
  const { goCoin, goCoinPremium, amm } = contracts;

  // Create a batched simulation that includes:
  // 1. Exchange rate data (public balances of AMM)
  // 2. User's private balances
  const batchCall = new BatchCall(wallet, [
    goCoin.methods.balance_of_public(amm.address),
    goCoinPremium.methods.balance_of_public(amm.address),
    goCoin.methods.balance_of_private(address),
    goCoinPremium.methods.balance_of_private(address),
  ]);

  const { result } = await batchCall.simulate({ from: address });
  const [token0Reserve, token1Reserve, gcBalance, gcpBalance] = result.map((r) => r.result);
  const exchangeRate = parseFloat(
    new BigDecimal(token1Reserve).divide(new BigDecimal(token0Reserve)).toString(),
  );

  return {
    exchangeRate,
    balances: {
      goCoin: gcBalance,
      goCoinPremium: gcpBalance,
    },
  };
}

/**
 * Executes a token swap through the AMM
 */
export async function executeSwap(
  contracts: SwapContracts,
  fromAddress: AztecAddress,
  amountOut: number,
  amountInMax: number,
): Promise<TxReceipt> {
  const { goCoin, goCoinPremium, amm } = contracts;

  const authwitNonce = Fr.random();
  const { receipt } = await amm.methods
    .swap_tokens_for_exact_tokens(
      goCoin.address,
      goCoinPremium.address,
      BigInt(Math.round(amountOut)),
      BigInt(Math.round(amountInMax)),
      authwitNonce,
    )
    .send({ from: fromAddress });
  return receipt;
}

// ── Subscription state tracking ─────────────────────────────────────

const SUBSCRIPTION_KEY = "goswap_subscriptions";

function subscriptionKey(fpcAddress: string, configIndex: number, userAddress: string): string {
  return `${fpcAddress}:${configIndex}:${userAddress}`;
}

function hasSubscription(fpcAddress: string, configIndex: number, userAddress: string): boolean {
  try {
    const subs = JSON.parse(localStorage.getItem(SUBSCRIPTION_KEY) ?? "{}");
    return !!subs[subscriptionKey(fpcAddress, configIndex, userAddress)];
  } catch {
    return false;
  }
}

function markSubscribed(fpcAddress: string, configIndex: number, userAddress: string) {
  try {
    const subs = JSON.parse(localStorage.getItem(SUBSCRIPTION_KEY) ?? "{}");
    subs[subscriptionKey(fpcAddress, configIndex, userAddress)] = true;
    localStorage.setItem(SUBSCRIPTION_KEY, JSON.stringify(subs));
  } catch {
    /* ignore */
  }
}

/**
 * Executes a sponsored swap through the SubscriptionFPC.
 * Uses subscribe on first call, sponsor on subsequent calls.
 */
export async function executeSponsoredSwap(
  network: NetworkConfig,
  amm: SwapContracts["amm"],
  goCoin: SwapContracts["goCoin"],
  goCoinPremium: SwapContracts["goCoinPremium"],
  fpc: SubscriptionFPC,
  userAddress: AztecAddress,
  amountOut: number,
  amountInMax: number,
): Promise<TxReceipt> {
  const subFPC = network.subscriptionFPC;
  if (!subFPC) {
    throw new Error("No subscriptionFPC configured for this network");
  }

  const authwitNonce = Fr.random();
  const call = await amm.methods
    .swap_tokens_for_exact_tokens_from(
      userAddress,
      goCoin.address,
      goCoinPremium.address,
      BigInt(Math.round(amountOut)),
      BigInt(Math.round(amountInMax)),
      authwitNonce,
    )
    .getFunctionCall();

  const fnConfig = subFPC.functions[amm.address.toString()]?.[call.selector.toString()];
  if (fnConfig == null) {
    throw new Error(
      `No subscription config found for AMM ${amm.address.toString()} selector ${call.selector.toString()}`,
    );
  }
  const { configIndex, gasLimits, hasPublicCall } = fnConfig;

  const subscribed = hasSubscription(subFPC.address, configIndex, userAddress.toString());

  if (subscribed) {
    const { receipt } = await fpc.helpers.sponsor({
      call,
      configIndex,
      userAddress,
      gasLimits,
      hasPublicCall,
    });
    return receipt;
  } else {
    const { receipt } = await fpc.helpers.subscribe({
      call,
      configIndex,
      userAddress,
      gasLimits,
      hasPublicCall,
    });
    markSubscribed(subFPC.address, configIndex, userAddress.toString());
    return receipt;
  }
}

/**
 * Executes an unsponsored swap directly through the AMM (user pays their own gas).
 */
export async function executeUnsponsoredSwap(
  contracts: SwapContracts,
  fromAddress: AztecAddress,
  amountOut: number,
  amountInMax: number,
): Promise<TxReceipt> {
  const { goCoin, goCoinPremium, amm } = contracts;
  const authwitNonce = Fr.random();
  const { receipt } = await amm.methods
    .swap_tokens_for_exact_tokens(
      goCoin.address,
      goCoinPremium.address,
      BigInt(Math.round(amountOut)),
      BigInt(Math.round(amountInMax)),
      authwitNonce,
    )
    .send({ from: fromAddress });
  return receipt;
}

export type SubscriptionStatusKind =
  | "loading" // query in flight
  | "no_fpc" // no FPC configured for this network — hide everything
  | "sponsored" // user not yet subscribed, slots available — first swap will be free
  | "active" // user has subscription with uses remaining — swap is free
  | "full" // no slots left, user never subscribed — must bridge
  | "depleted"; // user's uses exhausted — must bridge

export interface SubscriptionStatus {
  kind: SubscriptionStatusKind;
  availableSlots?: number;
  remainingUses?: number;
}

/**
 * Queries the subscription FPC for swap sponsorship status.
 * Returns the status kind based on available slots and user subscription state.
 */
export async function querySubscriptionStatus(
  network: NetworkConfig,
  amm: SwapContracts["amm"],
  userAddress: AztecAddress,
  fpc: SubscriptionFPC | null,
): Promise<SubscriptionStatus> {
  const subFPC = network.subscriptionFPC;
  if (!subFPC || !fpc) return { kind: "no_fpc" };

  // Derive configIndex + selector from the AMM's function map — take the first entry
  const ammFunctions = subFPC.functions[amm.address.toString()];
  if (!ammFunctions) return { kind: "no_fpc" };
  const [[selectorHex, fnConfig]] = Object.entries(ammFunctions);
  if (fnConfig == null) return { kind: "no_fpc" };
  const configIndex = fnConfig.configIndex;

  // Compute config_id the same way the contract does: poseidon2Hash([app, selector, index])
  const selector = FunctionSelector.fromString(selectorHex);
  const configId = await poseidon2Hash([
    amm.address.toField(),
    selector.toField(),
    new Fr(configIndex),
  ]);

  // SlotNote is owned by the FPC — must simulate from fpc.address
  // SubscriptionNote is owned by the user — must simulate from userAddress
  const [{ result: slotsResult }, { result: subInfoResult }] = await Promise.all([
    fpc.methods.count_available_slots(configId).simulate({ from: fpc.address }),
    fpc.methods.get_subscription_info(userAddress, configId).simulate({ from: userAddress }),
  ]);

  const availableSlots = Number(slotsResult);
  const [hasSubscription, remainingUses] = subInfoResult as [boolean, number];

  const remainingUsesNum = Number(remainingUses);
  if (hasSubscription) {
    return {
      kind: remainingUsesNum > 0 ? "active" : "depleted",
      availableSlots,
      remainingUses: remainingUsesNum,
    };
  }
  return { kind: availableSlots > 0 ? "sponsored" : "full", availableSlots };
}

/**
 * Parses a swap error into a user-friendly message
 */
export function parseSwapError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Swap failed. Please try again.";
  }

  const message = error.message;

  if (message.includes("Simulation failed")) {
    return message;
  }
  if (message.includes("User denied") || message.includes("rejected")) {
    return "Transaction was rejected in wallet";
  }
  if (message.includes("Insufficient") || message.includes("insufficient")) {
    return "Insufficient GoCoin balance for swap";
  }

  return message;
}

/**
 * Executes a drip (token claim) transaction.
 * Uses subscription FPC when configured, falls back to Aztec's sponsored FPC.
 */
export async function executeDrip(
  wallet: Wallet,
  network: NetworkConfig,
  pop: ProofOfPasswordContract,
  fpc: SubscriptionFPC,
  password: string,
  recipient: AztecAddress,
): Promise<TxReceipt> {
  const subFPC = network.subscriptionFPC;
  if (!subFPC) {
    throw new Error("No subscriptionFPC configured for this network");
  }

  const call = await pop.methods.check_password_and_mint(password, recipient).getFunctionCall();
  const fnConfig = subFPC.functions[pop.address.toString()]?.[call.selector.toString()];
  if (fnConfig == null) {
    throw new Error(
      `No subscription config found for ${pop.address.toString()} selector ${call.selector.toString()}`,
    );
  }
  const { configIndex, gasLimits, hasPublicCall } = fnConfig;

  const accounts = await wallet.getAccounts();
  const userAddress = accounts[0]?.item ?? recipient;

  const { receipt } = await fpc.helpers.subscribe({
    call,
    configIndex,
    userAddress,
    gasLimits,
    hasPublicCall,
  });
  return receipt;
}

/**
 * Execute an offchain token transfer.
 * Sends tokens privately with offchain note delivery, self-delivers the sender's
 * change note, and returns the recipient's offchain messages for link encoding.
 */
export async function executeTransferOffchain(
  network: NetworkConfig,
  contracts: SwapContracts,
  tokenKey: "goCoin" | "goCoinPremium",
  fromAddress: AztecAddress,
  recipient: AztecAddress,
  amount: bigint,
): Promise<{ receipt: TxReceipt; offchainMessages: OffchainMessage[] }> {
  const subFPC = network.subscriptionFPC;
  if (!subFPC) {
    throw new Error("No subscriptionFPC configured for this network");
  }

  const fpc = contracts.fpc;

  const token = contracts[tokenKey];

  const authwitNonce = Fr.random();
  const call = await token.methods
    .transfer_in_private_with_offchain_delivery(fromAddress, recipient, amount, authwitNonce)
    .getFunctionCall();

  const fnConfig = subFPC.functions[token.address.toString()]?.[call.selector.toString()];
  if (fnConfig == null) {
    throw new Error(
      `No subscription config found for token ${token.address.toString()} selector ${call.selector.toString()}`,
    );
  }
  const { configIndex, gasLimits, hasPublicCall } = fnConfig;

  const subscribed = hasSubscription(subFPC.address, configIndex, fromAddress.toString());

  let txResult: { receipt: TxReceipt; offchainMessages: OffchainMessage[] };
  if (subscribed) {
    txResult = await fpc.helpers.sponsor({
      call,
      configIndex,
      userAddress: fromAddress,
      gasLimits,
      hasPublicCall,
    });
  } else {
    txResult = await fpc.helpers.subscribe({
      call,
      configIndex,
      userAddress: fromAddress,
      gasLimits,
      hasPublicCall,
    });
    markSubscribed(subFPC.address, configIndex, fromAddress.toString());
  }

  const { receipt, offchainMessages } = txResult;

  // Self-deliver sender's change note (manual until F-324 lands)
  const senderMessages = offchainMessages.filter((msg: OffchainMessage) =>
    msg.recipient.equals(fromAddress),
  );
  if (senderMessages.length > 0) {
    await token.methods
      .offchain_receive(
        senderMessages.map((msg: OffchainMessage) => ({
          ciphertext: msg.payload,
          recipient: fromAddress,
          tx_hash: receipt.txHash.hash,
          anchor_block_timestamp: msg.anchorBlockTimestamp,
        })),
      )
      .simulate({ from: fromAddress });
  }

  // Filter and return recipient's messages for link encoding
  const recipientMessages = offchainMessages.filter((msg: OffchainMessage) =>
    msg.recipient.equals(recipient),
  );

  return { receipt, offchainMessages: recipientMessages };
}

/**
 * Parses a drip error into a user-friendly message
 */
export function parseDripError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Failed to claim GoCoin. Please try again.";
  }

  const message = error.message;

  if (message.includes("Simulation failed")) {
    return message;
  }
  if (message.includes("User denied") || message.includes("rejected")) {
    return "Transaction was rejected in wallet";
  }
  if (message.includes("password") || message.includes("Password")) {
    return "Invalid password. Please try again.";
  }
  if (message.includes("already claimed") || message.includes("Already claimed")) {
    return "You have already claimed your GoCoin tokens.";
  }

  return message;
}

/**
 * Parses a send (offchain transfer) error into a user-friendly message
 */
export function parseSendError(error: unknown): string {
  if (!(error instanceof Error)) return "Send failed. Please try again.";
  const msg = error.message;
  if (msg.includes("Balance too low")) return "Insufficient token balance";
  if (msg.includes("User denied") || msg.includes("rejected"))
    return "Transaction was rejected in wallet";
  if (msg.includes("invalid") && msg.includes("address")) return "Invalid recipient address";
  return msg;
}
