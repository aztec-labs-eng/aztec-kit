import { useState, useEffect, useCallback, useReducer, useRef } from "react";
import { formatUnits } from "viem";
import { shortAddress } from "@aztec-kit/common/ui";
import { useWallet } from "../../contexts/WalletContext";
import { useNetwork } from "../../contexts/NetworkContext";
import { useAztecWallet } from "../../contexts/AztecWalletContext";
import {
  fetchL1Addresses,
  getFeeJuiceBalance,
  getMintAmount,
  type L1Addresses,
} from "../../services";
import { getQueryParams } from "../../config/query-params";
import { bridgeReducer, IDLE } from "./reducer";
import {
  handleL1Pending,
  handleWaitingSync,
  handleClaiming,
  handleClaimSent,
} from "./phase-handlers";
import { handleBridge as executeBridgeAction } from "./bridge-tx";
import { loadSession, clearSession, saveSession, sessionToPhase, phaseToSession } from "./session";
import type {
  WizardStep,
  AztecChoice,
  RecipientChoice,
  BridgeStep,
  ClaimCredentials,
} from "./types";

// ── Hook ──────────────────────────────────────────────────────────────

export function useBridgeWizard() {
  const { account, connect, wrongChain, provider } = useWallet();
  const { activeNetwork } = useNetwork();
  const {
    status: aztecStatus,
    address: aztecAddress,
    feeJuiceBalance,
    connectAztecWallet,
    claimWithBootstrap,
    claimBatch,
    resetAccount,
    refreshFeeJuiceBalance,
    isExternal,
    error: aztecError,
  } = useAztecWallet();

  // ── Iframe / query-param overrides ────────────────────────────────
  const [{ recipients: queryRecipients, isIframe, forceEmbedded, parentOrigin }] =
    useState(getQueryParams);

  // ── Session restore ───────────────────────────────────────────────
  const [initialSession] = useState(() => loadSession(activeNetwork.id));
  const hasSession = !!initialSession;

  // ── Bridge state machine ──────────────────────────────────────────
  const [bridge, dispatch] = useReducer(bridgeReducer, initialSession, (session) =>
    session ? sessionToPhase(session) : IDLE,
  );

  // ── Wizard navigation ─────────────────────────────────────────────
  const [wizardStep, setWizardStep] = useState<WizardStep>(
    hasSession ? (initialSession?.isExternal ? 2 : 4) : 1,
  );
  const [expandedStep, setExpandedStep] = useState<WizardStep | null>(
    hasSession ? (initialSession?.isExternal ? 2 : 4) : 1,
  );
  const [error, setError] = useState<string | null>(null);

  // ── L1 wallet state ───────────────────────────────────────────────
  const [l1Addresses, setL1Addresses] = useState<(L1Addresses & { l1ChainId: number }) | null>(
    null,
  );
  const [balance, setBalance] = useState<{
    balance: bigint;
    formatted: string;
    decimals: number;
  } | null>(null);
  const [mintAmountValue, setMintAmountValue] = useState<bigint | null>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(false);

  // ── Form state ────────────────────────────────────────────────────
  const [aztecChoice, setAztecChoice] = useState<AztecChoice>(
    forceEmbedded ? "new" : hasSession ? (initialSession?.isExternal ? "existing" : "new") : null,
  );
  // For external wallets: user can choose "self" or "other"
  // For embedded wallets: always "other" (recipients are explicit addresses)
  const [recipientChoice, setRecipientChoice] = useState<RecipientChoice>(
    queryRecipients ? "other" : (initialSession?.recipientChoice ?? null),
  );
  // Force "other" for embedded wallets (they can't bridge to "self" — they need explicit addresses)
  const effectiveRecipientChoice: RecipientChoice = isExternal ? recipientChoice : "other";
  const [recipients, setRecipients] = useState<Array<{ address: string; amount: string }>>(() => {
    if (queryRecipients)
      return queryRecipients.map((r) => ({
        address: r.address,
        amount: r.amount ? (Number(r.amount) / 1e18).toString() : "",
      }));
    if (initialSession?.recipients?.length) return initialSession.recipients;
    return [{ address: "", amount: "" }];
  });
  const [bridgeStepLabel, setBridgeStepLabel] = useState(
    bridge.type === "l1-pending" ? "Resuming — waiting for L1 confirmation..." : "",
  );

  // ── Derived values ────────────────────────────────────────────────
  // L1 state
  const hasFaucet = !!l1Addresses?.feeAssetHandler;
  // Treat dust (< 10 FJ) as "no balance" so the faucet path still kicks in
  // when a past faucet mint left a sub-bridgeable amount in the wallet.
  const MIN_USABLE_BALANCE = 10n * 10n ** 18n;
  const hasBalance = balance != null && balance.balance >= MIN_USABLE_BALANCE;
  const faucetLocked = hasFaucet && !hasBalance;

  // Aztec account readiness
  const walletReady = aztecStatus === "ready" || aztecStatus === "funded";
  const aztecAccountReady = aztecChoice === "existing" ? aztecStatus === "funded" : walletReady;

  // Recipient readiness
  const recipientReady =
    effectiveRecipientChoice === "self"
      ? !!aztecAddress
      : recipients.length > 0 && recipients.every((r) => r.address.length >= 10);

  // Claim strategy — the single source of truth for how the L2 claim works
  const claimKind =
    isExternal && effectiveRecipientChoice === "self"
      ? ("self" as const)
      : aztecStatus === "funded"
        ? ("batch" as const)
        : ("bootstrap" as const);

  // Bridge phase flags (ordered: idle → l1-pending → waiting-l2-sync → ready/claiming/sent → done)
  const phase = bridge.type;
  const isBridging = phase === "l1-pending";
  const bridgeDone = phase !== "idle" && phase !== "l1-pending" && phase !== "error";
  const syncDone =
    bridgeDone && (phase !== "waiting-l2-sync" || bridge.messagesReady.every(Boolean));
  const isClaiming = phase === "claiming" || phase === "claim-sent";
  const claimed = phase === "done";

  // Refs for orchestrator callbacks (avoid stale closures)
  const walletReadyRef = useRef(walletReady);
  const feeJuiceBalanceRef = useRef(feeJuiceBalance);
  const providerRef = useRef(provider);
  const lastCredentialsRef = useRef<ClaimCredentials[] | null>(null);
  walletReadyRef.current = walletReady;
  feeJuiceBalanceRef.current = feeJuiceBalance;
  providerRef.current = provider;

  // ── Effect: Wallet status relay ───────────────────────────────────
  useEffect(() => {
    if (walletReady) {
      dispatch({ type: "WALLET_READY", feeJuiceBalance });
    } else {
      dispatch({ type: "WALLET_NOT_READY" });
    }
  }, [walletReady, feeJuiceBalance]);

  // ── Effect: Orchestrator ──────────────────────────────────────────
  useEffect(() => {
    const cancelled = { current: false };
    let cleanup: (() => void) | undefined;
    const ctx = {
      dispatch,
      activeNetwork,
      providerRef,
      walletReadyRef,
      feeJuiceBalanceRef,
      walletReady,
      feeJuiceBalance,
      claimWithBootstrap,
      claimBatch,
    };

    switch (bridge.type) {
      case "l1-pending":
        handleL1Pending(bridge, ctx, cancelled);
        break;
      case "waiting-l2-sync":
        cleanup = handleWaitingSync(bridge, ctx);
        break;
      case "ready-to-claim":
        dispatch({ type: "CLAIM_STARTED" });
        break;
      case "claiming":
        cleanup = handleClaiming(bridge, ctx, cancelled);
        break;
      case "claim-sent":
        cleanup = handleClaimSent(bridge, ctx, cancelled);
        break;
    }

    return () => {
      cancelled.current = true;
      cleanup?.();
    };
  }, [bridge.type]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Effect: Session persistence ───────────────────────────────────
  useEffect(() => {
    if (bridge.type === "done") {
      clearSession();
      return;
    }
    if (bridge.type === "idle" || bridge.type === "error") return;
    const session = phaseToSession(bridge, {
      recipientChoice: effectiveRecipientChoice ?? "self",
      isExternal,
      recipients,
      networkId: activeNetwork.id,
    });
    if (session) saveSession(session);
  }, [bridge, recipientChoice, isExternal, recipients, activeNetwork.id]);

  // ── Effect: Propagate reducer errors ──────────────────────────────
  useEffect(() => {
    if (bridge.type === "error") {
      setError(bridge.message);
      clearSession();
    }
  }, [bridge]);

  // ── Effect: Refresh balance after claim ───────────────────────────
  useEffect(() => {
    if (claimed) refreshFeeJuiceBalance();
  }, [claimed, refreshFeeJuiceBalance]);

  // ── Effect: postMessage to parent iframe ──────────────────────────
  useEffect(() => {
    if (!isIframe) return;
    const msg: Record<string, unknown> = { type: "gobridge" };
    switch (bridge.type) {
      case "l1-pending":
        msg.status = "bridging";
        break;
      case "waiting-l2-sync":
        msg.status = "syncing";
        break;
      case "done":
        msg.status = "complete";
        break;
      case "error":
        msg.status = "error";
        msg.error = bridge.message;
        break;
      default:
        return;
    }
    // Prefer `window.location.ancestorOrigins[0]` over `document.referrer`:
    // when the iframe navigates after load (e.g. props change → src update),
    // `document.referrer` becomes the iframe's own previous URL, which makes
    // `postMessage(msg, parentOrigin)` reject with "target origin does not
    // match recipient". `ancestorOrigins` always reflects the actual parent.
    // Fall back to `*` — our messages carry non-sensitive status only.
    const target = window.location.ancestorOrigins?.[0] ?? parentOrigin ?? "*";
    window.parent.postMessage(msg, target);
  }, [bridge.type, isIframe, parentOrigin]);

  // ── L1 info fetching ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setL1Addresses(null);
    setBalance(null);
    setMintAmountValue(null);
    setIsLoadingInfo(true);
    fetchL1Addresses(activeNetwork.aztecNodeUrl, activeNetwork.apiKey)
      .then((addresses) => {
        if (cancelled) return;
        setL1Addresses(addresses);
        if (addresses.feeAssetHandler)
          getMintAmount(
            activeNetwork.l1RpcUrl,
            addresses.l1ChainId,
            addresses.feeAssetHandler,
            providerRef.current,
          )
            .then((amt) => {
              if (!cancelled) setMintAmountValue(amt);
            })
            .catch(() => {
              // Handler exists but doesn't support mintAmount() — not a faucet,
              // or wallet is on the wrong chain. Leave mintAmountValue as null.
            });
      })
      .catch((err) => {
        if (!cancelled) setError(`Failed to fetch L1 addresses: ${err.message}`);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingInfo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeNetwork]);

  const refreshBalance = useCallback(async () => {
    if (!account || !l1Addresses) {
      setBalance(null);
      return;
    }
    try {
      setBalance(
        await getFeeJuiceBalance(
          activeNetwork.l1RpcUrl,
          l1Addresses.l1ChainId,
          l1Addresses.feeJuice,
          account,
          provider,
        ),
      );
    } catch (e) {
      console.warn("[bridge] Failed to refresh L1 balance:", e);
      setBalance(null);
    }
  }, [account, l1Addresses, activeNetwork, provider]);

  useEffect(() => {
    refreshBalance();
  }, [refreshBalance]);

  // ── Auto-advance effects ──────────────────────────────────────────
  useEffect(() => {
    if (account && !wrongChain && l1Addresses && balance && wizardStep === 1) {
      setWizardStep(2);
      setExpandedStep(2);
    }
  }, [account, wrongChain, l1Addresses, balance, wizardStep]);

  useEffect(() => {
    if (aztecChoice === "new" && aztecStatus === "disconnected") connectAztecWallet();
  }, [aztecChoice, aztecStatus, connectAztecWallet]);

  useEffect(() => {
    if (wizardStep === 2 && aztecAccountReady) {
      setWizardStep(3);
      setExpandedStep(3);
    }
  }, [wizardStep, aztecAccountReady]);

  const advanceFromStep3 = useCallback(() => {
    if (recipientReady && wizardStep === 3) {
      setWizardStep(4);
      setExpandedStep(4);
      if (faucetLocked && mintAmountValue != null) {
        const faucetAmount = formatUnits(mintAmountValue, 18);
        setRecipients((prev) => prev.map((r) => ({ ...r, amount: faucetAmount })));
      }
    }
  }, [recipientReady, wizardStep, faucetLocked, mintAmountValue]);

  useEffect(() => {
    if (faucetLocked && mintAmountValue != null && wizardStep >= 4) {
      setRecipients((prev) => {
        const anyEmpty = prev.some((r) => !r.amount);
        if (!anyEmpty) return prev;
        const faucetAmount = formatUnits(mintAmountValue, 18);
        return prev.map((r) => (r.amount ? r : { ...r, amount: faucetAmount }));
      });
    }
  }, [faucetLocked, mintAmountValue, wizardStep]);

  const recipientPrefilled = !!queryRecipients;

  useEffect(() => {
    if (
      wizardStep === 3 &&
      recipientReady &&
      (effectiveRecipientChoice === "self" || recipientPrefilled)
    )
      advanceFromStep3();
  }, [effectiveRecipientChoice, recipientReady, wizardStep, advanceFromStep3]);

  // ── Bridge action ─────────────────────────────────────────────────
  const onBridgeStep = useCallback((_step: BridgeStep, label?: string) => {
    if (label) setBridgeStepLabel(label);
  }, []);

  const handleBridge = async () => {
    if (!account || !l1Addresses || !provider) return;
    await executeBridgeAction({
      provider,
      l1Addresses,
      recipients,
      balance,
      faucetLocked,
      claimKind,
      claimerAddress: aztecAddress,
      mintAmountValue,
      onStep: onBridgeStep,
      dispatch,
      setError,
      refreshBalance,
    });
  };

  const handleReset = () => {
    clearSession();
    dispatch({ type: "RESET" });
    setWizardStep(1);
    setExpandedStep(1);
    setBridgeStepLabel("");
    setAztecChoice(null);
    setRecipientChoice(null);
    setRecipients([{ address: "", amount: "" }]);
    setError(null);
  };

  // ── Derived UI values ─────────────────────────────────────────────
  const toggle = (s: WizardStep) => setExpandedStep((prev) => (prev === s ? null : s));

  const stepStatus = (s: WizardStep): "completed" | "active" | "pending" => {
    if (s < wizardStep) return "completed";
    if (s === wizardStep) {
      if (s === 4 && claimed) return "completed";
      return "active";
    }
    return "pending";
  };

  const liveCredentials =
    bridge.type === "waiting-l2-sync" ||
    bridge.type === "ready-to-claim" ||
    bridge.type === "claiming" ||
    bridge.type === "claim-sent"
      ? bridge.allCredentials
      : null;
  if (liveCredentials) lastCredentialsRef.current = liveCredentials;
  const allCredentials = liveCredentials ?? lastCredentialsRef.current;

  const messageStatus: "ready" | "pending" | "error" =
    bridge.type === "waiting-l2-sync"
      ? bridge.messagesReady.every(Boolean)
        ? "ready"
        : "pending"
      : bridgeDone
        ? "ready"
        : "pending";

  const bridgeStep: BridgeStep =
    bridge.type === "l1-pending"
      ? "waiting-confirmation"
      : bridge.type === "error"
        ? "error"
        : bridge.type === "idle"
          ? "idle"
          : "done";

  // ── Step descriptions (computed here so consumers don't need raw state) ──
  const step1Desc = account
    ? wrongChain
      ? `${shortAddress(account)} — Wrong chain, switching...`
      : `${shortAddress(account)}${balance ? ` — FJ: ${balance.formatted}` : ""}`
    : "Connect your Ethereum wallet";

  const step2Desc = aztecAccountReady
    ? `${shortAddress(aztecAddress?.toString() ?? "")}${aztecStatus === "funded" ? " (funded)" : ""}${feeJuiceBalance && BigInt(feeJuiceBalance) > 0n ? ` — ${formatUnits(BigInt(feeJuiceBalance), 18)} FJ` : ""}`
    : "Do you have an Aztec wallet?";

  const step3Desc = recipientReady
    ? effectiveRecipientChoice === "self"
      ? "Bridge to myself"
      : recipients.length > 1
        ? `${recipients.length} recipients`
        : shortAddress(recipients[0]?.address ?? "")
    : "Who receives the fee juice?";

  const step4Desc = claimed
    ? "Complete!"
    : bridgeDone
      ? syncDone
        ? "Ready to claim"
        : "Waiting for L2 sync..."
      : "Bridge and claim fee juice";

  const progress =
    ((wizardStep - 1) / 4) * 100 + (bridgeDone ? (syncDone ? (claimed ? 25 : 18) : 10) : 0);

  // ── Per-step prop bundles ─────────────────────────────────────────
  const step1Props = { account, isLoadingInfo, balance, hasFaucet, wrongChain, connect };

  const step2Props = {
    aztecAccountReady,
    aztecChoice,
    setAztecChoice,
    aztecStatus,
    aztecError,
    resetAccount,
    forceEmbedded,
  };

  const step3Props = {
    canBridgeToSelf: isExternal,
    recipientChoice: effectiveRecipientChoice,
    setRecipientChoice,
    recipients,
    setRecipients,
    recipientReady,
    advanceFromStep3,
    prefilled: recipientPrefilled,
  };

  const step4Props = {
    recipients,
    setRecipients,
    allCredentials,
    balance,
    faucetLocked,
    hasBalance,
    bridgeStep,
    bridgeStepLabel,
    isBridging,
    bridgeDone,
    handleBridge,
    syncDone,
    messageStatus,
    claimed,
    isClaiming,
  };

  return {
    // Layout
    isIframe,
    progress,

    // Navigation
    wizardStep,
    expandedStep,
    toggle,
    stepStatus,

    // Step descriptions
    step1Desc,
    step2Desc,
    step3Desc,
    step4Desc,

    // Step props (spread into step components)
    step1Props,
    step2Props,
    step3Props,
    step4Props,

    // Actions
    handleReset,
    canRetryClaim: bridge.type === "error" && "allCredentials" in bridge,
    retryClaim: () => dispatch({ type: "RETRY_CLAIM", feeJuiceBalance }),

    // Error
    error: error || aztecError,
    clearError: () => setError(null),

    // Reset button state
    bridgeDone,
    claimed,
  };
}
