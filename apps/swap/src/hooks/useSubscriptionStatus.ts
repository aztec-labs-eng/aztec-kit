import { useState, useEffect, useRef, useCallback } from "react";
import type { SubscriptionStatus } from "../services/contractService";
import { querySubscriptionStatus } from "../services/contractService";
import { useWallet } from "../contexts/wallet";
import { useContracts } from "../contexts/contracts";
import { useNetwork } from "../contexts/network";
import { useOnboarding } from "../contexts/onboarding";

export function useSubscriptionStatus(swapPhase: string, dripPhase: string): SubscriptionStatus {
  const { currentAddress, node } = useWallet();
  const { getAmm, getFpc } = useContracts();
  const { activeNetwork } = useNetwork();
  const { status: onboardingStatus } = useOnboarding();
  const [status, setStatus] = useState<SubscriptionStatus>({ kind: "no_fpc" });
  const isFetchingRef = useRef(false);

  const isOnboarded = onboardingStatus === "completed";

  // Hide when not onboarded or no address
  useEffect(() => {
    if (!isOnboarded || !currentAddress) {
      setStatus({ kind: "no_fpc" });
    }
  }, [isOnboarded, currentAddress, activeNetwork]);

  const fetchStatus = useCallback(async () => {
    const amm = getAmm();
    const fpc = getFpc();
    if (!currentAddress || !node || !amm || !isOnboarded) return;
    if (!activeNetwork.subscriptionFPC) {
      setStatus({ kind: "no_fpc" });
      return;
    }
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      const result = await querySubscriptionStatus(node, activeNetwork, amm, currentAddress, fpc);
      setStatus(result);
    } catch {
      // Leave previous status on transient error to avoid flicker
    } finally {
      isFetchingRef.current = false;
    }
  }, [currentAddress, node, activeNetwork, getAmm, getFpc, isOnboarded]);

  // Fetch after onboarding completes
  useEffect(() => {
    if (onboardingStatus === "completed") {
      setStatus({ kind: "loading" });
      fetchStatus();
    }
  }, [onboardingStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch after swap succeeds
  useEffect(() => {
    if (swapPhase === "success") {
      fetchStatus();
    }
  }, [swapPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch after drip succeeds
  useEffect(() => {
    if (dripPhase === "success") {
      fetchStatus();
    }
  }, [dripPhase]); // eslint-disable-line react-hooks/exhaustive-deps

  return status;
}
