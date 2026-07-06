import { Box, Typography, Button, Alert, CircularProgress, Chip } from "@mui/material";
import { useEffect, useState, useCallback } from "react";
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { extractClaimPayload, type TransferLink } from "../../services/offchainLinkService";
import { ClaimProgress } from "./ClaimProgress";
import { ClaimSuccess } from "./ClaimSuccess";
import { GoSwapLogo } from "../GoSwapLogo";
import { useContracts } from "../../contexts/contracts";
import { useWallet } from "../../contexts/wallet";

type ClaimState =
  | { phase: "decoding" }
  | { phase: "preview"; data: TransferLink }
  | { phase: "claiming"; data: TransferLink }
  | { phase: "verifying"; data: TransferLink }
  | { phase: "claimed"; data: TransferLink; verified: boolean }
  | { phase: "error"; message: string };

interface ClaimPageProps {
  onClaimComplete: () => void;
}

export function ClaimPage({ onClaimComplete }: ClaimPageProps) {
  const [state, setState] = useState<ClaimState>({ phase: "decoding" });
  const { claimOffchainTransfer, registerBaseContracts, fetchBalances, isLoadingContracts } =
    useContracts();
  const { wallet, currentAddress } = useWallet();

  // Step 1: Decode the link on mount
  useEffect(() => {
    const data = extractClaimPayload();
    if (!data) {
      setState({ phase: "error", message: "Invalid or missing claim link." });
      return;
    }
    setState({ phase: "preview", data });
  }, []);

  // Step 2: Execute the claim
  const doClaim = useCallback(async () => {
    if (state.phase !== "preview") return;
    const { data } = state;
    setState({ phase: "claiming", data });

    try {
      // Ensure contracts are registered
      if (wallet && !isLoadingContracts) {
        try {
          await registerBaseContracts();
        } catch {
          /* may already be registered */
        }
      }

      if (!wallet || !currentAddress) {
        setState({ phase: "error", message: "No wallet available. Please refresh and try again." });
        return;
      }

      // Get balance before claim (for verification)
      let balanceBefore = 0n;
      try {
        const [gc, gcp] = await fetchBalances();
        balanceBefore = data.token === "gc" ? gc : gcp;
      } catch {
        /* new wallet may have no balance */
      }

      // Reconstruct Fr values and call offchain_receive
      const tokenKey = data.token === "gc" ? ("goCoin" as const) : ("goCoinPremium" as const);

      await claimOffchainTransfer(tokenKey, {
        ciphertext: data.payload.map((s: string) => Fr.fromString(s)),
        recipient: AztecAddress.fromStringUnsafe(data.recipient),
        tx_hash: Fr.fromString(data.txHash),
        anchor_block_timestamp: BigInt(data.anchorBlockTimestamp),
      });

      setState({ phase: "verifying", data });

      // Verify balance
      const [gcAfter, gcpAfter] = await fetchBalances();
      const balanceAfter = data.token === "gc" ? gcAfter : gcpAfter;
      const received = balanceAfter - balanceBefore;
      const expectedAmount = BigInt(Math.round(parseFloat(data.amount)));
      const verified = received >= expectedAmount;

      setState({ phase: "claimed", data, verified });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Claim failed. Please try again.";
      setState({ phase: "error", message });
    }
  }, [
    state,
    wallet,
    currentAddress,
    isLoadingContracts,
    registerBaseContracts,
    fetchBalances,
    claimOffchainTransfer,
  ]);

  // After a successful claim, return to the main app and land on the Send tab.
  // We just clear the hash and call the parent's callback — no reload, so the
  // user's session (wallet, onboarding, contracts) is preserved.
  const handleGoToSend = onClaimComplete;

  const tokenName = (t: string) => (t === "gc" ? "GoCoin" : "GoCoinPremium");

  return (
    <Box sx={{ py: 4 }}>
      <Box sx={{ textAlign: "center", mb: 6, mt: 4 }}>
        <Box sx={{ display: "flex", justifyContent: "center", mb: 2 }}>
          <GoSwapLogo height={56} />
        </Box>
      </Box>
      <Box
        sx={{
          p: 3,
          bgcolor: "background.paper",
          borderRadius: 2,
          border: "1px solid",
          borderColor: "divider",
        }}
      >
        {state.phase === "decoding" && (
          <Box sx={{ textAlign: "center", py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        )}
        {state.phase === "preview" && (
          <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
            <Typography variant="h5" color="text.primary">
              Someone sent you
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography variant="h4" color="primary" sx={{ fontWeight: "bold" }}>
                {state.data.amount} {tokenName(state.data.token)}
              </Typography>
              <Chip label="unverified" size="small" variant="outlined" />
            </Box>
            <Button
              variant="contained"
              size="large"
              onClick={doClaim}
              sx={{ mt: 2, fontWeight: "bold", px: 6 }}
            >
              Claim
            </Button>
          </Box>
        )}
        {state.phase === "claiming" && <ClaimProgress phase="claiming" />}
        {state.phase === "verifying" && <ClaimProgress phase="verifying" />}
        {state.phase === "claimed" && (
          <ClaimSuccess
            amount={state.data.amount}
            tokenName={tokenName(state.data.token)}
            verified={state.verified}
            onGoToSend={handleGoToSend}
          />
        )}
        {state.phase === "error" && <Alert severity="error">{state.message}</Alert>}
      </Box>
    </Box>
  );
}
