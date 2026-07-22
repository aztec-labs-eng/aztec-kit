/**
 * GoSwap Capability Manifest
 * Declares all permissions needed for the app to function with external wallets
 */

import type { AppCapabilities, ContractFunctionPattern } from "@aztec/aztec.js/wallet";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { NetworkConfig } from "./networks";

/**
 * Creates a comprehensive capability manifest for GoSwap based on network configuration.
 *
 * This manifest requests upfront authorization for all operations needed during:
 * - Onboarding (account access, contract registration, initial simulations)
 * - Swap flow (simulations, transaction execution, auth witness creation)
 * - Balance queries (private balance lookups)
 * - Drip flow (ProofOfPassword token claiming)
 *
 * With these capabilities granted:
 * - First launch: 1 capability dialog + per-transaction approvals
 * - Subsequent launches: 0 capability dialogs (already granted) + per-transaction approvals
 * - Reduction from 15+ authorization dialogs to 2 total
 *
 * @param network - Network configuration with contract addresses
 * @returns AppCapabilities manifest with specific contract addresses and functions
 */
export function createGoSwapCapabilities(network: NetworkConfig): AppCapabilities {
  // Parse contract addresses from network config
  const goCoinAddress = AztecAddress.fromStringUnsafe(network.contracts.goCoin);
  const goCoinPremiumAddress = AztecAddress.fromStringUnsafe(network.contracts.goCoinPremium);
  const ammAddress = AztecAddress.fromStringUnsafe(network.contracts.amm);
  const popAddress = AztecAddress.fromStringUnsafe(network.contracts.pop);

  // All contracts that need registration
  const contractAddresses = [ammAddress, goCoinAddress, goCoinPremiumAddress, popAddress];

  // Include subscription FPC if configured
  const hasSubFPC = !!network.subscriptionFPC;
  if (hasSubFPC) {
    contractAddresses.push(AztecAddress.fromStringUnsafe(network.subscriptionFPC!.address));
  }

  // Simulation patterns
  const txSimulationPatterns: ContractFunctionPattern[] = [
    { contract: goCoinAddress, function: "balance_of_public" },
    { contract: goCoinPremiumAddress, function: "balance_of_public" },
  ];

  const utilitySimulationPatterns: ContractFunctionPattern[] = [
    { contract: goCoinAddress, function: "balance_of_private" },
    { contract: goCoinPremiumAddress, function: "balance_of_private" },
  ];

  // Transaction patterns
  const transactionPatterns: ContractFunctionPattern[] = [
    { contract: ammAddress, function: "swap_tokens_for_exact_tokens" },
    { contract: popAddress, function: "check_password_and_mint" },
  ];

  // Subscription FPC: the user calls subscribe/sponsor which internally dispatch
  // the sponsored call + auth witnesses
  if (hasSubFPC) {
    const fpcAddress = AztecAddress.fromStringUnsafe(network.subscriptionFPC!.address);
    transactionPatterns.push(
      { contract: fpcAddress, function: "subscribe" },
      { contract: fpcAddress, function: "sponsor" },
    );
    // The _from variant of the swap is called by the FPC on behalf of the user
    transactionPatterns.push({
      contract: ammAddress,
      function: "swap_tokens_for_exact_tokens_from",
    });
    // Utility queries on the FPC: subscription status. (Available-seat counts
    // now come from a node nullifier-tree scan, not a contract simulation.)
    utilitySimulationPatterns.push({ contract: fpcAddress, function: "get_subscription_info" });
  }

  return {
    version: "1.0",
    metadata: {
      name: "GoSwap",
      version: "2.1.0",
      description: "Decentralized exchange for private token swaps on Aztec",
      url: "https://swap.aztec-kit.anothercoffeefor.me",
    },
    capabilities: [
      // Account access - needed for wallet connection and account selection
      {
        type: "accounts",
        canGet: true,
        canCreateAuthWit: false,
      },

      // Contract operations - specific contracts (AMM, tokens, ProofOfPassword, SponsoredFPC)
      {
        type: "contracts",
        contracts: contractAddresses,
        canRegister: true,
        canGetMetadata: true,
      },

      // Simulation - specific contract functions (balance queries, swap preview)
      {
        type: "simulation",
        utilities: {
          scope: utilitySimulationPatterns,
        },
        transactions: {
          scope: txSimulationPatterns,
        },
      },

      // Transaction execution - specific functions (swap, drip)
      {
        type: "transaction",
        scope: transactionPatterns,
      },
    ],
  };
}
