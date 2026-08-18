/**
 * Contracts Context
 * Manages contract instances and registration state
 */

import { createContext, useContext, useEffect, type ReactNode, useCallback } from "react";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Fr } from "@aztec/foundation/curves/bn254";
import type { TxReceipt } from "@aztec/stdlib/tx";
import type { AMMContract } from "@aztec-kit/contracts-aztec/artifacts/AMM";
import type { OffchainMessage } from "@aztec/aztec.js/contracts";
import type { SubscriptionFPC } from "@aztec-kit/contracts-aztec/subscription-fpc";
import { useWallet } from "../wallet";
import { useNetwork } from "../network";
import * as contractService from "../../services/contractService";
import { useContractsReducer } from "./reducer";

interface ContractsContextType {
  isLoadingContracts: boolean;

  // Registration methods
  registerBaseContracts: () => Promise<void>;
  registerDripContracts: () => Promise<void>;

  // Utility methods
  getAmm: () => AMMContract | null;
  getFpc: () => SubscriptionFPC | null;
  getExchangeRate: () => Promise<number>;
  swap: (amountOut: number, amountInMax: number) => Promise<TxReceipt>;
  unsponsoredSwap: (amountOut: number, amountInMax: number) => Promise<TxReceipt>;
  fetchBalances: () => Promise<[bigint, bigint]>;
  simulateOnboardingQueries: () => Promise<[number, bigint, bigint]>;
  drip: (password: string, recipient: AztecAddress) => Promise<TxReceipt>;
  sendOffchain: (
    tokenKey: "goCoin" | "goCoinPremium",
    recipient: AztecAddress,
    amount: bigint,
  ) => Promise<{ receipt: TxReceipt; offchainMessages: OffchainMessage[] }>;
  claimOffchainTransfer: (
    tokenKey: "goCoin" | "goCoinPremium",
    message: {
      ciphertext: Fr[];
      recipient: AztecAddress;
      tx_hash: Fr;
      anchor_block_timestamp: bigint;
    },
  ) => Promise<void>;
}

const ContractsContext = createContext<ContractsContextType | undefined>(undefined);

export function useContracts() {
  const context = useContext(ContractsContext);
  if (context === undefined) {
    throw new Error("useContracts must be used within a ContractsProvider");
  }
  return context;
}

interface ContractsProviderProps {
  children: ReactNode;
}

export function ContractsProvider({ children }: ContractsProviderProps) {
  const {
    wallet,
    currentAddress,
    isLoading: walletLoading,
    node,
    isUsingEmbeddedWallet,
  } = useWallet();
  const { activeNetwork } = useNetwork();

  const [state, actions] = useContractsReducer();

  // Register base contracts (AMM, tokens)
  const registerBaseContracts = useCallback(async () => {
    if (!wallet || !node) {
      throw new Error("Wallet not initialized");
    }

    actions.registerStart();

    try {
      const swapContracts = await contractService.registerSwapContracts(
        wallet,
        node,
        activeNetwork,
      );
      actions.registerSuccess("base", swapContracts);
    } catch (error) {
      actions.registerFail(error instanceof Error ? error.message : "Registration failed");
      throw error;
    }
  }, [wallet, node, activeNetwork, actions]);

  // Register drip contracts (ProofOfPassword)
  const registerDripContracts = useCallback(async () => {
    if (!wallet || !node) {
      throw new Error("Wallet not initialized");
    }

    actions.registerStart();

    try {
      const dripContracts = await contractService.registerDripContracts(
        wallet,
        node,
        activeNetwork,
      );
      actions.registerSuccess("drip", dripContracts);
    } catch (error) {
      actions.registerFail(error instanceof Error ? error.message : "Registration failed");
      throw error;
    }
  }, [wallet, node, activeNetwork, actions]);

  // Get AMM contract instance (for hooks that need it)
  const getAmm = useCallback((): AMMContract | null => {
    return state.contracts.amm ?? null;
  }, [state.contracts.amm]);

  // Get FPC wrapper instance (for hooks that need it)
  const getFpc = useCallback((): SubscriptionFPC | null => {
    return state.contracts.fpc ?? null;
  }, [state.contracts.fpc]);

  // Get exchange rate
  const getExchangeRate = useCallback(async (): Promise<number> => {
    if (
      !wallet ||
      !currentAddress ||
      !state.contracts.amm ||
      !state.contracts.goCoin ||
      !state.contracts.goCoinPremium
    ) {
      throw new Error("Contracts not initialized");
    }

    return contractService.getExchangeRate(
      wallet,
      {
        goCoin: state.contracts.goCoin,
        goCoinPremium: state.contracts.goCoinPremium,
        amm: state.contracts.amm,
        fpc: state.contracts.fpc,
      },
      currentAddress,
    );
  }, [wallet, state.contracts, currentAddress]);

  // Execute swap
  const swap = useCallback(
    async (amountOut: number, amountInMax: number): Promise<TxReceipt> => {
      if (
        !wallet ||
        !node ||
        !currentAddress ||
        !state.contracts.amm ||
        !state.contracts.goCoin ||
        !state.contracts.goCoinPremium ||
        !state.contracts.fpc
      ) {
        throw new Error("Contracts not initialized");
      }

      return contractService.executeSponsoredSwap(
        node,
        activeNetwork,
        state.contracts.amm,
        state.contracts.goCoin,
        state.contracts.goCoinPremium,
        state.contracts.fpc,
        currentAddress,
        amountOut,
        amountInMax,
      );
    },
    [wallet, node, currentAddress, activeNetwork, state.contracts],
  );

  // Execute unsponsored swap (user pays own gas)
  const unsponsoredSwap = useCallback(
    async (amountOut: number, amountInMax: number): Promise<TxReceipt> => {
      if (
        !wallet ||
        !currentAddress ||
        !state.contracts.amm ||
        !state.contracts.goCoin ||
        !state.contracts.goCoinPremium
      ) {
        throw new Error("Contracts not initialized");
      }

      return contractService.executeUnsponsoredSwap(
        {
          goCoin: state.contracts.goCoin,
          goCoinPremium: state.contracts.goCoinPremium,
          amm: state.contracts.amm,
          fpc: state.contracts.fpc,
        },
        currentAddress,
        amountOut,
        amountInMax,
      );
    },
    [wallet, currentAddress, state.contracts],
  );

  // Fetch balances
  const fetchBalances = useCallback(async (): Promise<[bigint, bigint]> => {
    if (!wallet || !currentAddress || !state.contracts.goCoin || !state.contracts.goCoinPremium) {
      throw new Error("Contracts not initialized");
    }

    return contractService.fetchBalances(
      wallet,
      {
        goCoin: state.contracts.goCoin,
        goCoinPremium: state.contracts.goCoinPremium,
        amm: state.contracts.amm!,
        fpc: state.contracts.fpc,
      },
      currentAddress,
    );
  }, [wallet, currentAddress, state.contracts]);

  // Simulate onboarding queries
  const simulateOnboardingQueries = useCallback(async (): Promise<[number, bigint, bigint]> => {
    if (
      !wallet ||
      !currentAddress ||
      !state.contracts.amm ||
      !state.contracts.goCoin ||
      !state.contracts.goCoinPremium
    ) {
      throw new Error("Contracts not initialized");
    }

    const result = await contractService.simulateOnboardingQueries(
      wallet,
      {
        goCoin: state.contracts.goCoin,
        goCoinPremium: state.contracts.goCoinPremium,
        amm: state.contracts.amm,
        fpc: state.contracts.fpc,
      },
      currentAddress,
    );

    return [result.exchangeRate, result.balances.goCoin, result.balances.goCoinPremium];
  }, [wallet, currentAddress, state.contracts]);

  // Execute drip
  const drip = useCallback(
    async (password: string, recipient: AztecAddress): Promise<TxReceipt> => {
      if (!wallet || !node || !state.contracts.pop || !state.contracts.fpc) {
        throw new Error("ProofOfPassword contract not initialized");
      }

      return contractService.executeDrip(
        node,
        wallet,
        activeNetwork,
        state.contracts.pop,
        state.contracts.fpc,
        password,
        recipient,
      );
    },
    [wallet, node, activeNetwork, state.contracts.pop, state.contracts.fpc],
  );

  // Execute offchain transfer (send with link)
  const sendOffchain = useCallback(
    async (tokenKey: "goCoin" | "goCoinPremium", recipient: AztecAddress, amount: bigint) => {
      if (
        !wallet ||
        !node ||
        !currentAddress ||
        !state.contracts.goCoin ||
        !state.contracts.goCoinPremium ||
        !state.contracts.amm
      ) {
        throw new Error("Contracts not initialized");
      }
      return contractService.executeTransferOffchain(
        node,
        activeNetwork,
        {
          goCoin: state.contracts.goCoin,
          goCoinPremium: state.contracts.goCoinPremium,
          amm: state.contracts.amm,
          fpc: state.contracts.fpc,
        },
        tokenKey,
        currentAddress,
        recipient,
        amount,
      );
    },
    [wallet, node, activeNetwork, currentAddress, state.contracts],
  );

  // Claim an offchain transfer via offchain_receive
  const claimOffchainTransfer = useCallback(
    async (
      tokenKey: "goCoin" | "goCoinPremium",
      message: {
        ciphertext: Fr[];
        recipient: AztecAddress;
        tx_hash: Fr;
        anchor_block_timestamp: bigint;
      },
    ) => {
      if (!wallet || !currentAddress || !state.contracts.goCoin || !state.contracts.goCoinPremium) {
        throw new Error("Contracts not initialized");
      }
      const token = tokenKey === "goCoin" ? state.contracts.goCoin : state.contracts.goCoinPremium;
      await token.methods.offchain_receive([message]).simulate({ from: currentAddress });
    },
    [wallet, currentAddress, state.contracts],
  );

  // Initialize contracts for embedded wallet
  useEffect(() => {
    async function initializeContracts() {
      if (walletLoading || !wallet) {
        actions.registerStart();
        return;
      }

      // For external wallets, don't initialize until onboarding registers contracts
      if (!isUsingEmbeddedWallet) {
        return;
      }

      try {
        await registerBaseContracts();
      } catch (err) {
        actions.registerFail(err instanceof Error ? err.message : "Failed to initialize");
      }
    }

    initializeContracts();
  }, [wallet, walletLoading, isUsingEmbeddedWallet, registerBaseContracts, actions]);

  const value: ContractsContextType = {
    isLoadingContracts: state.isLoading,
    registerBaseContracts,
    registerDripContracts,
    getAmm,
    getFpc,
    getExchangeRate,
    swap,
    unsponsoredSwap,
    fetchBalances,
    simulateOnboardingQueries,
    drip,
    sendOffchain,
    claimOffchainTransfer,
  };

  return <ContractsContext.Provider value={value}>{children}</ContractsContext.Provider>;
}
