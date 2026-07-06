import { useEffect, useState } from "react";
import {
  Box,
  Typography,
  TextField,
  Button,
  LinearProgress,
  CircularProgress,
} from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import { formatUnits } from "viem";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { shortAddress } from "@aztec-kit/common/ui";
import { BRIDGE_STEP_LABELS } from "../constants";
import { useAztecWallet } from "../../../contexts/AztecWalletContext";
import type { Recipient, BridgeStep, ClaimCredentials, MessageStatus } from "../types";

interface Step4BridgeClaimProps {
  recipients: Recipient[];
  setRecipients: (r: Recipient[]) => void;
  allCredentials: ClaimCredentials[] | null;
  balance: { formatted: string; decimals: number; balance: bigint } | null;
  faucetLocked: boolean;
  hasBalance: boolean;

  bridgeStep: BridgeStep;
  bridgeStepLabel: string;
  isBridging: boolean;
  bridgeDone: boolean;
  handleBridge: () => void;

  syncDone: boolean;
  messageStatus: MessageStatus;
  claimed: boolean;
  isClaiming: boolean;
}

function ClaimSummary({ allCredentials }: { allCredentials: ClaimCredentials[] }) {
  const { activeWallet, address } = useAztecWallet();
  const [balances, setBalances] = useState<Record<string, string | null>>({});

  // Fetch FJ balance for each recipient after claiming
  useEffect(() => {
    if (!activeWallet || !address) return;
    let cancelled = false;

    (async () => {
      const fj = FeeJuiceContract.at(activeWallet);

      const results: Record<string, string | null> = {};
      await Promise.all(
        allCredentials.map(async (cred) => {
          try {
            const target = AztecAddress.fromStringUnsafe(cred.recipient);
            const { result } = await fj.methods
              .balance_of_public(target)
              .simulate({ from: address });
            if (!cancelled) results[cred.recipient] = formatUnits(BigInt(result.toString()), 18);
          } catch {
            if (!cancelled) results[cred.recipient] = null;
          }
        }),
      );
      if (!cancelled) setBalances(results);
    })();

    return () => {
      cancelled = true;
    };
  }, [activeWallet, address, allCredentials.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect the auto-inserted gas payer: first credential matches the embedded wallet
  // and there are additional user-provided recipients
  const gasPayerIndex =
    address && allCredentials.length > 1 && allCredentials[0].recipient === address.toString()
      ? 0
      : -1;

  return (
    <Box sx={{ mt: 1 }}>
      {allCredentials.map((cred, i) => {
        const bal = balances[cred.recipient];
        const isGasPayer = i === gasPayerIndex;
        return (
          <Box
            key={i}
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              py: 0.5,
              borderBottom: i < allCredentials.length - 1 ? "1px solid" : "none",
              borderColor: "divider",
              ...(isGasPayer && { opacity: 0.6 }),
            }}
          >
            <Box>
              <Typography variant="body2" sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}>
                {shortAddress(cred.recipient)}
              </Typography>
              {isGasPayer && (
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.65rem" }}>
                  Gas payer (auto)
                </Typography>
              )}
            </Box>
            <Box sx={{ textAlign: "right" }}>
              <Typography
                variant="body2"
                fontWeight={600}
                color={isGasPayer ? "text.secondary" : "primary"}
              >
                +{formatUnits(BigInt(cred.claimAmount), 18)} FJ
              </Typography>
              {bal !== undefined ? (
                <Typography variant="caption" color="text.secondary">
                  Balance: {bal ?? "—"} FJ
                </Typography>
              ) : (
                <CircularProgress size={10} sx={{ ml: 0.5 }} />
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

export function Step4BridgeClaim({
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
}: Step4BridgeClaimProps) {
  const updateAmount = (index: number, amount: string) => {
    const updated = [...recipients];
    updated[index] = { ...updated[index], amount };
    setRecipients(updated);
  };

  const allAmountsFilled = recipients.every((r) => !!r.amount);

  return (
    <>
      {/* Phase 1: Amounts + Bridge */}
      {!bridgeDone && (
        <Box>
          {!faucetLocked && (
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                mb: 0.5,
              }}
            >
              <Typography variant="body2" color="text.secondary" fontWeight={500}>
                Balance: {balance?.formatted ?? "..."}
              </Typography>
              {hasBalance && recipients.length === 1 && (
                <Button
                  size="small"
                  onClick={() => updateAmount(0, balance!.formatted)}
                  sx={{
                    minWidth: "auto",
                    px: 1,
                    py: 0.25,
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    color: "primary.main",
                    backgroundColor: "rgba(212,255,40,0.1)",
                    border: "1px solid",
                    borderColor: "primary.main",
                    "&:hover": { backgroundColor: "rgba(212,255,40,0.2)" },
                  }}
                >
                  MAX
                </Button>
              )}
            </Box>
          )}

          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, mb: 2 }}>
            {recipients.map((r, i) => (
              <TextField
                key={i}
                fullWidth
                label={recipients.length > 1 ? `Amount for ${shortAddress(r.address)}` : "Amount"}
                placeholder="0.0"
                value={r.amount}
                onChange={(e) => {
                  if (!faucetLocked) updateAmount(i, e.target.value);
                }}
                disabled={isBridging || faucetLocked}
                type="number"
                helperText={faucetLocked ? "Fixed faucet amount" : undefined}
                size={recipients.length > 1 ? "small" : "medium"}
              />
            ))}
          </Box>

          {isBridging ? (
            <Box>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                {bridgeStepLabel || BRIDGE_STEP_LABELS[bridgeStep]}
              </Typography>
              <LinearProgress />
            </Box>
          ) : (
            <Button
              fullWidth
              variant="contained"
              color="primary"
              onClick={handleBridge}
              disabled={!allAmountsFilled}
              data-testid="bridge-submit"
            >
              {faucetLocked ? "Mint & Bridge" : "Bridge"}
            </Button>
          )}
        </Box>
      )}

      {/* Phase 2+: Post-bridge sub-steps */}
      {bridgeDone && (
        <Box
          data-testid="bridge-post-phase"
          data-l1-confirmed="true"
          data-l2-synced={syncDone ? "true" : "false"}
          data-claimed={claimed ? "true" : "false"}
        >
          <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
            {/* 4a: L1 Deposit */}
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <CheckCircleIcon sx={{ color: "primary.main", fontSize: 18 }} />
              <Typography variant="body2" fontWeight={500}>
                L1 deposit confirmed
              </Typography>
            </Box>

            {/* 4b: L2 Sync */}
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              {syncDone ? (
                <CheckCircleIcon sx={{ color: "primary.main", fontSize: 18 }} />
              ) : (
                <RadioButtonUncheckedIcon sx={{ color: "text.disabled", fontSize: 18 }} />
              )}
              <Box sx={{ flex: 1 }}>
                <Typography
                  variant="body2"
                  fontWeight={500}
                  color={syncDone ? "text.primary" : "text.secondary"}
                >
                  L2 message sync
                </Typography>
                {!syncDone && messageStatus === "pending" && <LinearProgress sx={{ mt: 0.5 }} />}
                {messageStatus === "error" && (
                  <Typography variant="caption" color="warning.main">
                    Could not verify — check manually
                  </Typography>
                )}
              </Box>
            </Box>

            {/* 4c: Claim */}
            <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
              {claimed ? (
                <CheckCircleIcon sx={{ color: "primary.main", fontSize: 18, mt: 0.25 }} />
              ) : (
                <RadioButtonUncheckedIcon
                  sx={{
                    color: syncDone ? "text.primary" : "text.disabled",
                    fontSize: 18,
                    mt: 0.25,
                  }}
                />
              )}
              <Box sx={{ flex: 1 }}>
                <Typography
                  variant="body2"
                  fontWeight={500}
                  color={claimed ? "text.primary" : syncDone ? "text.primary" : "text.disabled"}
                >
                  {claimed ? "Claimed" : "Claim fee juice"}
                </Typography>
                {claimed && allCredentials && <ClaimSummary allCredentials={allCredentials} />}
              </Box>
            </Box>
          </Box>

          {/* Claim progress */}
          {!claimed && syncDone && isClaiming && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                Claiming...
              </Typography>
              <LinearProgress />
            </Box>
          )}
        </Box>
      )}
    </>
  );
}
