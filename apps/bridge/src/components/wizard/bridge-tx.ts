/**
 * Plain async function for the L1 bridge transaction.
 * Extracted from useBridgeWizard to keep the hook focused on state.
 *
 * Three claim scenarios:
 *   "bootstrap" — embedded wallet has no gas: prepend a gas-payer credential for the claimer
 *   "batch"     — wallet already funded (embedded or external): bridge only user recipients
 */

import { formatUnits, parseUnits, type EIP1193Provider } from "viem";
import { bridgeFeeJuice, bridgeMultiple, type L1Addresses } from "../../services";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import { EPHEMERAL_CLAIM_GAS_FJ } from "./constants";
import type { BridgeStep, BridgeAction, ClaimKind } from "./types";

interface HandleBridgeParams {
  /** EIP-1193 provider of the connected L1 wallet */
  provider: EIP1193Provider;
  l1Addresses: L1Addresses & { l1ChainId: number };
  recipients: Array<{ address: string; amount: string }>;
  balance: { balance: bigint; formatted: string; decimals: number } | null;
  faucetLocked: boolean;
  /** How the claim will be executed on L2 */
  claimKind: ClaimKind;
  /** The embedded wallet's address — used as gas payer in bootstrap mode */
  claimerAddress: AztecAddress | null;
  mintAmountValue: bigint | null;
  onStep: (step: BridgeStep, label?: string) => void;
  dispatch: (action: BridgeAction) => void;
  setError: (error: string | null) => void;
  refreshBalance: () => Promise<void>;
}

export async function handleBridge(params: HandleBridgeParams): Promise<void> {
  const {
    provider,
    l1Addresses,
    recipients,
    balance,
    faucetLocked,
    claimKind,
    claimerAddress,
    mintAmountValue,
    onStep,
    dispatch,
    setError,
    refreshBalance,
  } = params;

  setError(null);

  try {
    // ── Validate ──────────────────────────────────────────────────────
    if (claimKind !== "self" && !recipients.every((r) => r.address.length >= 10)) {
      setError("Invalid recipient address");
      return;
    }
    if (!recipients.every((r) => r.amount)) {
      setError("Please enter an amount for each recipient");
      return;
    }

    const parsedRecipients = recipients.map((r) => ({
      address: r.address,
      amount: parseUnits(r.amount, balance?.decimals ?? 18),
    }));

    if (parsedRecipients.some((r) => r.amount <= 0n)) {
      setError("Amounts must be greater than 0");
      return;
    }

    // ── Build the full recipient list ─────────────────────────────────
    // "self": bridge to the claimer's own address (external wallet self-bridge)
    // "bootstrap": prepend the claimer as gas payer + user recipients
    // "batch": user recipients only
    let allBridgeRecipients = parsedRecipients;
    if (claimKind === "self") {
      if (!claimerAddress) {
        setError("No wallet address available");
        return;
      }
      allBridgeRecipients = [
        { address: claimerAddress.toString(), amount: parsedRecipients[0].amount },
      ];
    } else if (claimKind === "bootstrap") {
      if (!claimerAddress) {
        setError("No claimer address available");
        return;
      }
      const ephAmount =
        faucetLocked && mintAmountValue ? mintAmountValue : parseUnits(EPHEMERAL_CLAIM_GAS_FJ, 18);
      allBridgeRecipients = [
        { address: claimerAddress.toString(), amount: ephAmount },
        ...parsedRecipients,
      ];
    }

    // ── Balance check ─────────────────────────────────────────────────
    const totalNeeded = allBridgeRecipients.reduce((sum, r) => sum + r.amount, 0n);
    if (!faucetLocked && balance && totalNeeded > balance.balance) {
      setError(`Insufficient balance. Need ${formatUnits(totalNeeded, balance.decimals)}`);
      return;
    }

    // ── Execute L1 bridge ─────────────────────────────────────────────
    const onPending = (pending: {
      l1TxHash: string;
      secrets: Array<{ secret: string; secretHash: string }>;
      recipients: string[];
      amounts: string[];
    }) => dispatch({ type: "BRIDGE_STARTED", pendingBridge: pending });

    let allCredentials;
    if (allBridgeRecipients.length === 1) {
      const result = await bridgeFeeJuice({
        provider,
        chainId: l1Addresses.l1ChainId,
        addresses: l1Addresses,
        aztecRecipient: allBridgeRecipients[0].address,
        amount: allBridgeRecipients[0].amount,
        mint: faucetLocked,
        onStep,
        onPending,
      });
      allCredentials = [result];
    } else {
      allCredentials = await bridgeMultiple({
        provider,
        chainId: l1Addresses.l1ChainId,
        addresses: l1Addresses,
        recipients: allBridgeRecipients,
        mint: faucetLocked,
        onStep,
        onPending,
      });
    }

    dispatch({ type: "L1_CONFIRMED", allCredentials, claimKind });
    await refreshBalance();
  } catch (err: unknown) {
    dispatch({
      type: "ERROR",
      message: err instanceof Error ? err.message : "Bridge failed",
    });
  }
}
