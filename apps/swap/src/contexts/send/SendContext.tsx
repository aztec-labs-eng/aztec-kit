/**
 * Send Context
 * Manages offchain transfer flow and link generation
 */

import { createContext, useContext, type ReactNode, useCallback } from "react";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { useSendReducer, type SendState, type SendPhase, type DeliveryMode } from "./reducer";
import { useContracts } from "../contracts";
import { useWallet } from "../wallet";
import { useNetwork } from "../network";
import { encodeTransferLink, type TransferLink } from "../../services/offchainLinkService";
import { addSentTransfer } from "../../services/sentHistoryService";

interface SendContextType extends SendState {
  setToken: (token: "gc" | "gcp") => void;
  setDeliveryMode: (mode: DeliveryMode) => void;
  setRecipientAddress: (address: string) => void;
  setAmount: (amount: string) => void;
  startSend: () => void;
  generatingLink: () => void;
  linkReady: (link: string) => void;
  sendComplete: () => void;
  sendError: (error: string) => void;
  dismissError: () => void;
  reset: () => void;
  canSend: boolean;
  executeSend: () => Promise<void>;
}

const SendContext = createContext<SendContextType | undefined>(undefined);

export function useSend() {
  const context = useContext(SendContext);
  if (context === undefined) {
    throw new Error("useSend must be used within a SendProvider");
  }
  return context;
}

interface SendProviderProps {
  children: ReactNode;
}

export function SendProvider({ children }: SendProviderProps) {
  const [state, actions] = useSendReducer();
  const { sendOffchain, sendOnchain, isLoadingContracts } = useContracts();
  const { currentAddress } = useWallet();
  const { activeNetwork } = useNetwork();

  const canSend =
    !!state.amount &&
    parseFloat(state.amount) > 0 &&
    !!state.recipientAddress &&
    !isLoadingContracts &&
    !!currentAddress;

  const executeSend = useCallback(async () => {
    if (!currentAddress || !state.recipientAddress || !state.amount) {
      actions.sendError("Missing required fields");
      return;
    }

    actions.startSend();

    try {
      const recipient = AztecAddress.fromStringUnsafe(state.recipientAddress);
      const amount = BigInt(Math.round(parseFloat(state.amount)));
      const tokenKey = state.token === "gc" ? ("goCoin" as const) : ("goCoinPremium" as const);

      // On-chain path: constrained delivery, no claim link — the recipient
      // discovers the note by scanning (see executeTransferOnchain).
      if (state.deliveryMode === "onchain") {
        const { receipt } = await sendOnchain(tokenKey, recipient, amount);
        actions.sendComplete();
        addSentTransfer(currentAddress.toString(), {
          id: receipt.txHash.toString(),
          token: state.token,
          amount: state.amount,
          recipient: state.recipientAddress,
          link: "",
          createdAt: Date.now(),
          status: "confirmed",
        });
        return;
      }

      const contractAddress = activeNetwork.contracts[tokenKey];
      const { receipt, offchainMessages } = await sendOffchain(tokenKey, recipient, amount);

      actions.generatingLink();

      const recipientMessage = offchainMessages[0];
      if (!recipientMessage) {
        throw new Error("No offchain message generated for recipient");
      }

      const linkData: TransferLink = {
        token: state.token,
        amount: state.amount,
        recipient: state.recipientAddress,
        contractAddress,
        txHash: receipt.txHash.toString(),
        anchorBlockTimestamp: recipientMessage.anchorBlockTimestamp.toString(),
        payload: recipientMessage.payload.map((f: { toString(): string }) => f.toString()),
      };

      const link = encodeTransferLink(linkData);
      actions.linkReady(link);

      addSentTransfer(currentAddress.toString(), {
        id: receipt.txHash.toString(),
        token: state.token,
        amount: state.amount,
        recipient: state.recipientAddress,
        link,
        createdAt: Date.now(),
        status: "confirmed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Send failed. Please try again.";
      actions.sendError(message);
    }
  }, [
    currentAddress,
    state.recipientAddress,
    state.amount,
    state.token,
    state.deliveryMode,
    activeNetwork,
    sendOffchain,
    sendOnchain,
    actions,
  ]);

  const value: SendContextType = {
    ...state,
    setToken: actions.setToken,
    setDeliveryMode: actions.setDeliveryMode,
    setRecipientAddress: actions.setRecipientAddress,
    setAmount: actions.setAmount,
    startSend: actions.startSend,
    generatingLink: actions.generatingLink,
    linkReady: actions.linkReady,
    sendComplete: actions.sendComplete,
    sendError: actions.sendError,
    dismissError: actions.dismissError,
    reset: actions.reset,
    canSend,
    executeSend,
  };

  return <SendContext.Provider value={value}>{children}</SendContext.Provider>;
}

export type { SendPhase };
