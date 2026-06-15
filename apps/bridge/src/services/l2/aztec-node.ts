import { type AztecNode, waitForTx } from "@aztec/aztec.js/node";
import { createNode } from "@aztec-kit/common/node";
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { Fr } from "@aztec/foundation/curves/bn254";
import { TxHash, TxStatus } from "@aztec/stdlib/tx";
import { zeroAddress } from "viem";
import type { Hex } from "viem";
import { MESSAGE_POLL_INTERVAL_MS } from "../../components/wizard/constants";
import type { L1Addresses, MessageStatus } from "../types";

// ── Cached Aztec Node Client ─────────────────────────────────────────

let cachedNode: { url: string; apiKey?: string; client: AztecNode } | null = null;

export function getAztecNode(aztecNodeUrl: string, apiKey?: string): AztecNode {
  if (cachedNode && cachedNode.url === aztecNodeUrl && cachedNode.apiKey === apiKey)
    return cachedNode.client;
  const client = createNode(aztecNodeUrl, apiKey);
  cachedNode = { url: aztecNodeUrl, apiKey, client };
  return client;
}

// ── Fetch L1 Addresses from Aztec Node ───────────────────────────────

export async function fetchL1Addresses(
  aztecNodeUrl: string,
  apiKey?: string,
): Promise<L1Addresses & { l1ChainId: number }> {
  const node = getAztecNode(aztecNodeUrl, apiKey);
  const nodeInfo = await node.getNodeInfo();
  const addrs = nodeInfo.l1ContractAddresses;

  let handlerStr: string | null = null;
  if ("feeAssetHandlerAddress" in addrs) {
    const rawHandler = (addrs as Record<string, unknown>).feeAssetHandlerAddress;
    if (rawHandler && typeof rawHandler === "object" && "toString" in rawHandler) {
      handlerStr = (rawHandler as { toString(): string }).toString();
    } else if (typeof rawHandler === "string") {
      handlerStr = rawHandler;
    }
  }
  const isZero = !handlerStr || handlerStr === zeroAddress;

  return {
    feeJuicePortal: addrs.feeJuicePortalAddress.toString() as Hex,
    feeJuice: addrs.feeJuiceAddress.toString() as Hex,
    feeAssetHandler: isZero ? null : (handlerStr as Hex),
    l1ChainId: nodeInfo.l1ChainId,
  };
}

// ── L1→L2 Message Readiness ──────────────────────────────────────────

/**
 * Polls the Aztec node to check if the L1→L2 message is ready to claim.
 * Calls onStatus with updates. Returns when ready or on error/cancel.
 */
export function pollMessageReadiness(
  aztecNodeUrl: string,
  messageHash: string,
  onStatus: (status: MessageStatus) => void,
  apiKey?: string,
): { cancel: () => void } {
  let cancelled = false;

  const poll = async () => {
    const node = getAztecNode(aztecNodeUrl, apiKey);
    const msgHash = Fr.fromHexString(messageHash);
    while (!cancelled) {
      try {
        const ready = await isL1ToL2MessageReady(node, msgHash);
        if (ready) {
          onStatus("ready");
          return;
        }
      } catch {
        // Node may not have seen the message yet - keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, MESSAGE_POLL_INTERVAL_MS));
    }
  };

  onStatus("pending");
  poll().catch(() => {
    if (!cancelled) onStatus("error");
  });

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

// ── Wait for L2 Tx ───────────────────────────────────────────────────

/**
 * Waits for an already-sent Aztec L2 tx to be mined.
 * Used to resume waiting after a page refresh.
 */
export async function waitForAztecTx(aztecNodeUrl: string, txHashStr: string, apiKey?: string) {
  const node = getAztecNode(aztecNodeUrl, apiKey);
  const txHash = TxHash.fromString(txHashStr);
  return waitForTx(node, txHash, { waitForStatus: TxStatus.PROPOSED });
}
