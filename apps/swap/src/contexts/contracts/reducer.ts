/**
 * Contracts Reducer
 * Manages contract instances and registration state
 */

import type { TokenContract } from "@aztec/noir-contracts.js/Token";
import type { AMMContract } from "@aztec-kit/contracts-aztec/artifacts/AMM";
import type { ProofOfPasswordContract } from "@aztec-kit/contracts-aztec/artifacts/ProofOfPassword";
import type { SubscriptionFPC } from "@aztec-kit/contracts-aztec/subscription-fpc";
import { createReducerHook, type ActionsFrom } from "../utils";

// =============================================================================
// State
// =============================================================================

export interface Contracts {
  goCoin: TokenContract | null;
  goCoinPremium: TokenContract | null;
  amm: AMMContract | null;
  pop: ProofOfPasswordContract | null;
  fpc: SubscriptionFPC | null;
}

export type ContractRegistrationStage = "base" | "drip";

export interface ContractsState {
  contracts: Contracts;
  isLoading: boolean;
}

export const initialContractsState: ContractsState = {
  contracts: {
    goCoin: null,
    goCoinPremium: null,
    amm: null,
    pop: null,
    fpc: null,
  },
  isLoading: true,
};

// =============================================================================
// Actions
// =============================================================================

export const contractsActions = {
  registerStart: () => ({ type: "contracts/REGISTER_START" as const }),
  registerSuccess: (stage: ContractRegistrationStage, contracts: Partial<Contracts>) => ({
    type: "contracts/REGISTER_SUCCESS" as const,
    stage,
    contracts,
  }),
  registerFail: (error: string) => ({ type: "contracts/REGISTER_FAIL" as const, error }),
};

export type ContractsAction = ActionsFrom<typeof contractsActions>;

// =============================================================================
// Reducer
// =============================================================================

export function contractsReducer(state: ContractsState, action: ContractsAction): ContractsState {
  switch (action.type) {
    case "contracts/REGISTER_START":
      return { ...state, isLoading: true };

    case "contracts/REGISTER_SUCCESS":
      return {
        ...state,
        contracts: { ...state.contracts, ...action.contracts },
        isLoading: false,
      };

    case "contracts/REGISTER_FAIL":
      return { ...state, isLoading: false };

    default:
      return state;
  }
}

// =============================================================================
// Hook
// =============================================================================

export const useContractsReducer = createReducerHook(
  contractsReducer,
  contractsActions,
  initialContractsState,
);
