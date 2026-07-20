import type { EIP1193Provider, Hex } from "viem";
import { BRIDGE_CONTRACT_ABI, getBridgeAddress } from "@aztec-kit/contracts-ethereum";
import type { L1Addresses, BridgeStep, PendingBridge, ClaimCredentials } from "../types";
import {
  getL1Clients,
  getL1PublicClient,
  toHex64,
  generateClaimSecret,
  extractAllDepositEvents,
  viemReadContract,
  erc20ReadAbi,
  erc20WriteAbi,
} from "./clients";

// ── Shared bridge implementation ─────────────────────────────────────

interface BridgeRecipient {
  address: string;
  amount: bigint;
}

interface ExecuteBridgeParams {
  /** EIP-1193 provider of the wallet the user selected */
  provider: EIP1193Provider;
  chainId: number;
  addresses: L1Addresses;
  recipients: BridgeRecipient[];
  mint: boolean;
  onStep: (step: BridgeStep, label?: string) => void;
  onPending?: (pending: PendingBridge) => void;
}

/**
 * Core bridge implementation that handles both single and multi-recipient bridges.
 * Both `bridgeFeeJuice` and `bridgeMultiple` delegate to this function.
 */
async function executeBridge(params: ExecuteBridgeParams): Promise<ClaimCredentials[]> {
  const { provider, chainId, addresses, recipients, mint, onStep, onPending } = params;
  const isSingle = recipients.length === 1;

  const { publicClient, walletClient, account, chain } = await getL1Clients(provider, chainId);
  const totalAmount = recipients.reduce((sum, r) => sum + r.amount, 0n);

  // Generate claim secrets for each recipient
  const secrets = await Promise.all(recipients.map(() => generateClaimSecret()));
  const secretHashHexes = secrets.map((s) => toHex64(s.secretHash));
  const recipientHexes = recipients.map(
    (r) => (r.address.startsWith("0x") ? r.address : `0x${r.address}`) as Hex,
  );
  const amounts = recipients.map((r) => r.amount);

  const bridgeAddr = getBridgeAddress();

  // Build PendingBridge for crash recovery
  const pendingBridge: PendingBridge = {
    l1TxHash: "", // filled after send
    secrets: secrets.map((s, i) => ({
      secret: toHex64(s.secret),
      secretHash: secretHashHexes[i],
    })),
    recipients: recipients.map((r) => r.address),
    amounts: recipients.map((r) => r.amount.toString()),
  };

  let hash: Hex;

  if (mint && addresses.feeAssetHandler) {
    // Faucet path: contract mints + bridges atomically
    const label = isSingle ? undefined : `Minting & bridging to ${recipients.length} recipients...`;
    onStep("bridging", label);

    if (isSingle) {
      hash = await walletClient.writeContract({
        address: bridgeAddr,
        abi: BRIDGE_CONTRACT_ABI,
        functionName: "mintAndBridge",
        args: [
          addresses.feeAssetHandler,
          addresses.feeJuice,
          addresses.feeJuicePortal,
          recipientHexes[0],
          amounts[0],
          secretHashHexes[0],
        ],
        account,
        chain,
      });
    } else {
      hash = await walletClient.writeContract({
        address: bridgeAddr,
        abi: BRIDGE_CONTRACT_ABI,
        functionName: "mintAndBridgeMultiple",
        args: [
          addresses.feeAssetHandler,
          addresses.feeJuice,
          addresses.feeJuicePortal,
          recipientHexes,
          amounts,
          secretHashHexes,
        ],
        account,
        chain,
      });
    }
  } else {
    // Non-faucet path: approve if needed, then bridge
    const currentAllowance = (await viemReadContract(publicClient, {
      address: addresses.feeJuice,
      abi: erc20ReadAbi,
      functionName: "allowance",
      args: [account, bridgeAddr],
    })) as bigint;

    if (currentAllowance < totalAmount) {
      onStep("approving", isSingle ? undefined : "Approving tokens...");
      const approveHash = await walletClient.writeContract({
        address: addresses.feeJuice,
        abi: erc20WriteAbi,
        functionName: "approve",
        args: [bridgeAddr, totalAmount],
        account,
        chain,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    const label = isSingle ? undefined : `Bridging to ${recipients.length} recipients...`;
    onStep("bridging", label);

    if (isSingle) {
      hash = await walletClient.writeContract({
        address: bridgeAddr,
        abi: BRIDGE_CONTRACT_ABI,
        functionName: "bridge",
        args: [
          addresses.feeJuice,
          addresses.feeJuicePortal,
          recipientHexes[0],
          amounts[0],
          secretHashHexes[0],
        ],
        account,
        chain,
      });
    } else {
      hash = await walletClient.writeContract({
        address: bridgeAddr,
        abi: BRIDGE_CONTRACT_ABI,
        functionName: "bridgeMultiple",
        args: [
          addresses.feeJuice,
          addresses.feeJuicePortal,
          recipientHexes,
          amounts,
          secretHashHexes,
        ],
        account,
        chain,
      });
    }
  }

  onStep("waiting-confirmation", isSingle ? undefined : "Waiting for L1 confirmation...");
  pendingBridge.l1TxHash = hash;
  onPending?.(pendingBridge);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  // Extract deposit events
  const events = extractAllDepositEvents(receipt);
  if (events.length < recipients.length) {
    throw new Error(`Expected ${recipients.length} deposit events, got ${events.length}`);
  }

  onStep("done");

  return recipients.map((r, i) => ({
    claimSecret: toHex64(secrets[i].secret),
    claimSecretHash: secretHashHexes[i],
    messageHash: events[i].key,
    messageLeafIndex: events[i].index.toString(),
    claimAmount: r.amount.toString(),
    recipient: r.address,
  }));
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Bridges fee juice to a single Aztec recipient in one L1 transaction.
 */
export async function bridgeFeeJuice(params: {
  provider: EIP1193Provider;
  chainId: number;
  addresses: L1Addresses;
  aztecRecipient: string;
  amount: bigint;
  mint: boolean;
  onStep: (step: BridgeStep) => void;
  onPending?: (pending: PendingBridge) => void;
}): Promise<ClaimCredentials> {
  const [result] = await executeBridge({
    provider: params.provider,
    chainId: params.chainId,
    addresses: params.addresses,
    recipients: [{ address: params.aztecRecipient, amount: params.amount }],
    mint: params.mint,
    onStep: params.onStep,
    onPending: params.onPending,
  });
  return result;
}

/**
 * Bridges fee juice to N Aztec recipients in a single L1 transaction.
 */
export async function bridgeMultiple(params: {
  provider: EIP1193Provider;
  chainId: number;
  addresses: L1Addresses;
  recipients: Array<{ address: string; amount: bigint }>;
  mint: boolean;
  onStep: (step: BridgeStep, label?: string) => void;
  onPending?: (pending: PendingBridge) => void;
}): Promise<ClaimCredentials[]> {
  return executeBridge({
    provider: params.provider,
    chainId: params.chainId,
    addresses: params.addresses,
    recipients: params.recipients,
    mint: params.mint,
    onStep: params.onStep,
    onPending: params.onPending,
  });
}

// ── Resume pending bridge ────────────────────────────────────────────

/**
 * Resumes a pending L1 bridge by waiting for the tx receipt and extracting credentials.
 * Used when the user refreshes while waiting for L1 confirmation.
 *
 * Reads through the selected wallet's provider when available, otherwise the
 * configured RPC — a resume must not depend on the wallet being reconnected.
 */
export async function resumePendingBridge(params: {
  chainId: number;
  l1RpcUrl: string;
  pending: PendingBridge;
  provider?: EIP1193Provider | null;
}): Promise<ClaimCredentials[]> {
  const { chainId, l1RpcUrl, pending, provider } = params;
  const publicClient = getL1PublicClient(l1RpcUrl, chainId, provider);

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: pending.l1TxHash as Hex,
  });

  const events = extractAllDepositEvents(receipt);
  if (events.length < pending.secrets.length) {
    throw new Error(`Expected ${pending.secrets.length} deposit events, got ${events.length}`);
  }

  return pending.secrets.map((s, i) => ({
    claimSecret: s.secret as Hex,
    claimSecretHash: s.secretHash as Hex,
    messageHash: events[i].key,
    messageLeafIndex: events[i].index.toString(),
    claimAmount: pending.amounts[i],
    recipient: pending.recipients[i],
  }));
}
