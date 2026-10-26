/**
 * Wallet Reducer
 * Manages wallet instances (embedded vs external) and current address
 */

import type { AztecNode } from "@aztec-labs/aztec.js/node";
import type { Wallet } from "@aztec-labs/aztec.js/wallet";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { createReducerHook, type ActionsFrom } from "../utils";

// =============================================================================
// State
// =============================================================================

export interface WalletState {
  wallet: Wallet | null;
  node: AztecNode | null;
  currentAddress: AztecAddress | null;
  isUsingEmbeddedWallet: boolean;
  isLoading: boolean;
  error: string | null;
}

export const initialWalletState: WalletState = {
  wallet: null,
  node: null,
  currentAddress: null,
  isUsingEmbeddedWallet: true,
  isLoading: true,
  error: null,
};

// =============================================================================
// Actions
// =============================================================================

export const walletActions = {
  initStart: () => ({ type: "wallet/INIT_START" as const }),
  initEmbedded: (wallet: Wallet, node: AztecNode, address: AztecAddress) => ({
    type: "wallet/INIT_EMBEDDED" as const,
    wallet,
    node,
    address,
  }),
  setExternal: (wallet: Wallet) => ({ type: "wallet/SET_EXTERNAL" as const, wallet }),
  setAddress: (address: AztecAddress | null) => ({ type: "wallet/SET_ADDRESS" as const, address }),
  disconnect: () => ({ type: "wallet/DISCONNECT" as const }),
  restoreEmbedded: (wallet: Wallet, address: AztecAddress | null) => ({
    type: "wallet/RESTORE_EMBEDDED" as const,
    wallet,
    address,
  }),
  setError: (error: string) => ({ type: "wallet/SET_ERROR" as const, error }),
};

export type WalletAction = ActionsFrom<typeof walletActions>;

// =============================================================================
// Reducer
// =============================================================================

export function walletReducer(state: WalletState, action: WalletAction): WalletState {
  switch (action.type) {
    case "wallet/INIT_START":
      return { ...state, isLoading: true, error: null };

    case "wallet/INIT_EMBEDDED":
      return {
        ...state,
        wallet: action.wallet,
        node: action.node,
        currentAddress: action.address,
        isUsingEmbeddedWallet: true,
        isLoading: false,
        error: null,
      };

    case "wallet/SET_EXTERNAL":
      return {
        ...state,
        wallet: action.wallet,
        currentAddress: null,
        isUsingEmbeddedWallet: false,
      };

    case "wallet/SET_ADDRESS":
      return { ...state, currentAddress: action.address };

    case "wallet/DISCONNECT":
      return {
        ...state,
        wallet: null,
        currentAddress: null,
        isUsingEmbeddedWallet: true,
      };

    case "wallet/RESTORE_EMBEDDED":
      return {
        ...state,
        wallet: action.wallet,
        currentAddress: action.address,
        isUsingEmbeddedWallet: true,
      };

    case "wallet/SET_ERROR":
      return { ...state, isLoading: false, error: action.error };

    default:
      return state;
  }
}

// =============================================================================
// Hook
// =============================================================================

export const useWalletReducer = createReducerHook(walletReducer, walletActions, initialWalletState);
