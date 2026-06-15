/**
 * Plain async functions for each bridge phase's side effects.
 * Called from the orchestrator effect in useBridgeWizard.
 * Each returns a cleanup function (or undefined).
 */

import { pollMessageReadiness, waitForAztecTx, resumePendingBridge } from "../../services";
import { txProgress } from "@aztec-kit/embedded-wallet";
import { PHASE_COLOR_MINING } from "./constants";
import type { BridgePhase, BridgeAction, ClaimCredentials } from "./types";

type Dispatch = (action: BridgeAction) => void;

interface OrchestratorContext {
  dispatch: Dispatch;
  activeNetwork: { l1ChainId: number; aztecNodeUrl: string; apiKey?: string };
  walletReadyRef: { current: boolean };
  feeJuiceBalanceRef: { current: string | null };
  walletReady: boolean;
  feeJuiceBalance: string | null;
  claimWithBootstrap: (bootstrap: ClaimCredentials, others: ClaimCredentials[]) => Promise<void>;
  claimBatch: (claims: ClaimCredentials[]) => Promise<void>;
}

export function handleL1Pending(
  bridge: Extract<BridgePhase, { type: "l1-pending" }>,
  ctx: OrchestratorContext,
  cancelled: { current: boolean },
): undefined {
  const { pendingBridge } = bridge;
  resumePendingBridge(ctx.activeNetwork.l1ChainId, pendingBridge)
    .then((allCredentials) => {
      if (cancelled.current) return;
      ctx.dispatch({ type: "L1_CONFIRMED", allCredentials });
    })
    .catch((err) => {
      if (!cancelled.current)
        ctx.dispatch({
          type: "ERROR",
          message: err instanceof Error ? err.message : "L1 resume failed",
        });
    });
  return undefined;
}

export function handleWaitingSync(
  bridge: Extract<BridgePhase, { type: "waiting-l2-sync" }>,
  ctx: OrchestratorContext,
): () => void {
  const cancellers: Array<() => void> = [];

  bridge.allCredentials.forEach((cred, index) => {
    if (bridge.messagesReady[index]) return;
    const { cancel } = pollMessageReadiness(
      ctx.activeNetwork.aztecNodeUrl,
      cred.messageHash,
      (status) => {
        if (status === "ready") {
          ctx.dispatch({
            type: "MESSAGE_READY",
            index,
            feeJuiceBalance: ctx.feeJuiceBalanceRef.current,
            walletReady: ctx.walletReadyRef.current,
          });
        }
      },
      ctx.activeNetwork.apiKey,
    );
    cancellers.push(cancel);
  });

  // If all messages were already ready (restore), re-check wallet
  if (bridge.messagesReady.every(Boolean) && ctx.walletReady) {
    ctx.dispatch({ type: "WALLET_READY", feeJuiceBalance: ctx.feeJuiceBalance });
  }

  return () => cancellers.forEach((c) => c());
}

export function handleClaiming(
  bridge: Extract<BridgePhase, { type: "claiming" }>,
  ctx: OrchestratorContext,
  cancelled: { current: boolean },
): () => void {
  const { claimPath } = bridge;

  let capturedTxHash: string | null = null;
  const unsub = txProgress.subscribe((event) => {
    if (event.phase === "sending" && event.aztecTxHash) {
      capturedTxHash = event.aztecTxHash;
      ctx.dispatch({
        type: "TX_SENT",
        txHash: event.aztecTxHash,
        snapshot: {
          txId: event.txId,
          label: event.label,
          phases: event.phases,
          startTime: event.startTime,
          aztecTxHash: event.aztecTxHash,
        },
      });
    }
  });

  const claimPromise = (async () => {
    switch (claimPath.kind) {
      case "bootstrap":
        return ctx.claimWithBootstrap(claimPath.bootstrapClaim, claimPath.otherClaims);
      case "batch":
        return ctx.claimBatch(claimPath.claims);
    }
  })();

  claimPromise
    .then(() => {
      if (!capturedTxHash && !cancelled.current) {
        ctx.dispatch({ type: "CLAIM_DONE" });
      }
    })
    .catch((err) => {
      if (!cancelled.current)
        ctx.dispatch({
          type: "ERROR",
          message: err instanceof Error ? err.message : "Claim failed",
        });
    });

  return unsub;
}

export function handleClaimSent(
  bridge: Extract<BridgePhase, { type: "claim-sent" }>,
  ctx: OrchestratorContext,
  cancelled: { current: boolean },
): () => void {
  const { txHash, snapshot } = bridge;
  const miningStart = Date.now();

  const timer = setTimeout(() => {
    txProgress.emit({
      txId: snapshot.txId,
      label: snapshot.label,
      phase: "mining",
      startTime: snapshot.startTime,
      phaseStartTime: miningStart,
      phases: snapshot.phases,
      aztecTxHash: txHash,
    });
  }, 0);

  waitForAztecTx(ctx.activeNetwork.aztecNodeUrl, txHash, ctx.activeNetwork.apiKey)
    .then(() => {
      if (cancelled.current) return;
      ctx.dispatch({ type: "CLAIM_DONE" });
      txProgress.emit({
        txId: snapshot.txId,
        label: snapshot.label,
        phase: "complete",
        startTime: snapshot.startTime,
        phaseStartTime: Date.now(),
        phases: [
          ...snapshot.phases,
          { name: "Mining", duration: Date.now() - miningStart, color: PHASE_COLOR_MINING },
        ],
        aztecTxHash: txHash,
      });
    })
    .catch((err) => {
      if (cancelled.current) return;
      ctx.dispatch({
        type: "ERROR",
        message: err instanceof Error ? err.message : "Claim tx failed",
      });
      txProgress.emit({
        txId: snapshot.txId,
        label: snapshot.label,
        phase: "error",
        startTime: snapshot.startTime,
        phaseStartTime: Date.now(),
        phases: [
          ...snapshot.phases,
          { name: "Mining", duration: Date.now() - miningStart, color: PHASE_COLOR_MINING },
        ],
        error: err instanceof Error ? err.message : "Claim tx failed",
      });
    });

  return () => clearTimeout(timer);
}
