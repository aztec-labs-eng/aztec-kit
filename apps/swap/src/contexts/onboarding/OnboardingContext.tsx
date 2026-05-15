/**
 * Onboarding Context
 * Manages the onboarding flow orchestration using a reducer
 * Single unified flow: connect → register → simulate → [if no balance: drip detour] → completed
 */

import { createContext, useContext, useCallback, useEffect, useRef, type ReactNode } from "react";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { useWallet } from "../wallet";
import { useContracts } from "../contracts";
import {
  useOnboardingReducer,
  calculateCurrentStep,
  getOnboardingSteps,
  getOnboardingStepsWithDrip,
  ONBOARDING_STEPS,
  ONBOARDING_STEPS_WITH_DRIP,
  type OnboardingStatus,
  type OnboardingStep,
  type OnboardingResult,
  type DripPhase,
} from "./reducer";
import { parseDripError } from "../../services/contractService";

export type { OnboardingStatus, OnboardingStep };
export {
  ONBOARDING_STEPS,
  ONBOARDING_STEPS_WITH_DRIP,
  getOnboardingSteps,
  getOnboardingStepsWithDrip,
};

interface OnboardingContextType {
  // State
  status: OnboardingStatus;
  error: string | null;
  currentStep: number;
  totalSteps: number;
  steps: OnboardingStep[];
  isOnboardingModalOpen: boolean;
  onboardingResult: OnboardingResult | null;
  needsDrip: boolean;
  useEmbeddedWallet: boolean;

  // Derived state
  isSwapPending: boolean;
  isDripPending: boolean;
  dripPassword: string | null;

  // Tracking state
  hasRegisteredBase: boolean;
  hasSimulated: boolean;
  hasSimulationGrant: boolean;

  // Drip execution state
  dripPhase: DripPhase;
  dripError: string | null;
  isDripping: boolean;

  // Actions
  startOnboarding: (initiatedSwap?: boolean) => void;
  advanceStatus: (status: OnboardingStatus) => void;
  setOnboardingResult: (result: OnboardingResult) => void;
  markRegistered: () => void;
  markSimulated: () => void;
  setSimulationGrant: (granted: boolean) => void;
  selectEmbeddedWallet: () => void;
  closeModal: () => void;
  clearSwapPending: () => void;
  completeDripOnboarding: (password: string) => void;
  completeDripExecution: () => void;
  clearDripPassword: () => void;
  resetOnboarding: () => void;
  dismissDripError: () => void;
}

const OnboardingContext = createContext<OnboardingContextType | undefined>(undefined);

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (context === undefined) {
    throw new Error("useOnboarding must be used within an OnboardingProvider");
  }
  return context;
}

interface OnboardingProviderProps {
  children: ReactNode;
}

function setStoredOnboardingStatus(address: AztecAddress | null, completed: boolean) {
  if (!address) return;
  try {
    localStorage.setItem(`onboarding_complete_${address.toString()}`, String(completed));
  } catch {
    // Ignore localStorage errors
  }
}

export function OnboardingProvider({ children }: OnboardingProviderProps) {
  const { wallet, currentAddress, isUsingEmbeddedWallet, node } = useWallet();
  const {
    simulateOnboardingQueries,
    isLoadingContracts,
    registerBaseContracts,
    registerDripContracts,
    drip,
  } = useContracts();

  const [state, actions] = useOnboardingReducer();

  // Ref to prevent duplicate drip execution
  const dripTriggeredRef = useRef(false);

  // Refs to prevent duplicate execution under React StrictMode (which double-invokes
  // effects in dev) and from stale-closure re-runs after state updates trigger renders
  // mid-await.
  const registerBaseTriggeredRef = useRef(false);
  const simulateTriggeredRef = useRef(false);
  const registerDripTriggeredRef = useRef(false);

  // Computed values
  const steps = state.needsDrip
    ? getOnboardingStepsWithDrip(state.hasSimulationGrant, state.useEmbeddedWallet)
    : getOnboardingSteps(state.hasSimulationGrant, state.useEmbeddedWallet);
  const currentStep = calculateCurrentStep(state.status, state.needsDrip, state.useEmbeddedWallet);
  const baseSteps = steps.length;
  const totalSteps = state.needsDrip ? baseSteps + 1 : baseSteps;
  const isSwapPending = state.status === "completed" && state.pendingSwap;
  const isDripPending = state.status === "executing_drip" && state.dripPassword !== null;
  const isDripping = state.dripPhase === "sending" || state.dripPhase === "mining";

  // Onboarding orchestration effect
  useEffect(() => {
    async function handleOnboardingFlow() {
      if (state.status === "idle" || state.status === "completed" || state.status === "error")
        return;

      try {
        // Step 1: After external wallet connection, go straight to registering.
        // The embedded-wallet path does NOT register here: ContractsProvider's
        // own mount effect drives registration the moment the wallet is ready
        // (and is the sole driver on reload-after-onboarded, where this effect
        // stays in 'idle'). Duplicating the call here races that effect — both
        // pass the existence check and both invoke wallet.registerContract,
        // tripping a SQLite UNIQUE on the second insert.
        if (
          state.status === "connecting" &&
          currentAddress &&
          !isUsingEmbeddedWallet &&
          !state.hasRegisteredBase &&
          !registerBaseTriggeredRef.current
        ) {
          registerBaseTriggeredRef.current = true;
          actions.markRegistered();
          actions.advanceStatus("registering");
          await registerBaseContracts();
        }

        // Step 2: After contracts are registered, simulate to check balances
        if (
          state.status === "registering" &&
          !isLoadingContracts &&
          currentAddress &&
          !state.hasSimulated &&
          !simulateTriggeredRef.current
        ) {
          simulateTriggeredRef.current = true;
          actions.markSimulated();
          actions.advanceStatus("simulating");

          const [exchangeRate, gcBalance, gcpBalance] = await simulateOnboardingQueries();

          const result: OnboardingResult = {
            exchangeRate,
            balances: {
              goCoin: gcBalance,
              goCoinPremium: gcpBalance,
            },
          };
          actions.setResult(result);

          // Check if user has no tokens - need drip detour
          const hasNoTokens = gcBalance === 0n;

          if (hasNoTokens) {
            if (!registerDripTriggeredRef.current) {
              registerDripTriggeredRef.current = true;
              actions.markNeedsDrip();
              actions.advanceStatus("registering_drip");
              await registerDripContracts();
              actions.advanceStatus("awaiting_drip");
            }
          } else {
            // User has tokens, complete onboarding
            setStoredOnboardingStatus(currentAddress, true);
            actions.complete();
          }
        }
      } catch (error) {
        actions.setError(error instanceof Error ? error.message : "Onboarding failed");
      }
    }

    handleOnboardingFlow();
  }, [
    state.status,
    state.hasRegisteredBase,
    state.hasSimulated,
    state.useEmbeddedWallet,
    currentAddress,
    isUsingEmbeddedWallet,
    wallet,
    node,
    isLoadingContracts,
    simulateOnboardingQueries,
    registerBaseContracts,
    registerDripContracts,
    actions,
  ]);

  // Drip execution effect - triggers when password is provided during onboarding
  useEffect(() => {
    async function handleDrip() {
      if (
        !isDripPending ||
        !state.dripPassword ||
        isDripping ||
        state.dripPhase === "error" ||
        dripTriggeredRef.current ||
        !currentAddress
      ) {
        return;
      }

      dripTriggeredRef.current = true;
      actions.startDrip();

      try {
        await drip(state.dripPassword, currentAddress);
        actions.dripSuccess();
        setStoredOnboardingStatus(currentAddress, true);
        actions.complete();
      } catch (error) {
        actions.dripError(parseDripError(error));
      } finally {
        dripTriggeredRef.current = false;
      }
    }

    handleDrip();
  }, [isDripPending, state.dripPassword, isDripping, currentAddress, drip, actions]);

  // Only need useCallback for functions that do more than just forward to actions
  const completeDripExecution = useCallback(() => {
    setStoredOnboardingStatus(currentAddress, true);
    actions.complete();
  }, [currentAddress, actions]);

  const value: OnboardingContextType = {
    status: state.status,
    error: state.error,
    currentStep,
    totalSteps,
    steps,
    isOnboardingModalOpen: state.isModalOpen,
    onboardingResult: state.result,
    needsDrip: state.needsDrip,
    useEmbeddedWallet: state.useEmbeddedWallet,
    isSwapPending,
    isDripPending,
    dripPassword: state.dripPassword,
    hasRegisteredBase: state.hasRegisteredBase,
    hasSimulated: state.hasSimulated,
    hasSimulationGrant: state.hasSimulationGrant,
    dripPhase: state.dripPhase,
    dripError: state.dripError,
    isDripping,
    startOnboarding: actions.startFlow,
    advanceStatus: actions.advanceStatus,
    setOnboardingResult: actions.setResult,
    markRegistered: actions.markRegistered,
    markSimulated: actions.markSimulated,
    setSimulationGrant: actions.setSimulationGrant,
    selectEmbeddedWallet: actions.selectEmbeddedWallet,
    closeModal: actions.closeModal,
    clearSwapPending: actions.clearPendingSwap,
    completeDripOnboarding: actions.setPassword,
    completeDripExecution,
    clearDripPassword: actions.closeModal,
    resetOnboarding: actions.reset,
    dismissDripError: actions.dismissDripError,
  };

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}
