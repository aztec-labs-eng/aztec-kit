import {
  Box,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  CircularProgress,
  Typography,
} from "@mui/material";
import { useSend } from "../../contexts/send";
import { useWallet } from "../../contexts/wallet";
import { useContracts } from "../../contexts/contracts";
import { SendForm } from "./SendForm";
import { SendProgress } from "./SendProgress";
import { LinkDisplay } from "./LinkDisplay";
import { SentHistory } from "./SentHistory";
import { DripPasswordInput } from "../onboarding/DripPasswordInput";
import { parseDripError } from "../../services/contractService";
import { useEffect, useState } from "react";

type FaucetPhase = "idle" | "registering" | "awaiting_password" | "dripping";

export function SendContainer() {
  const { phase, error, generatedLink, token, amount, recipientAddress, dismissError, reset } =
    useSend();
  const { currentAddress } = useWallet();
  const { fetchBalances, registerDripContracts, drip } = useContracts();
  const [balances, setBalances] = useState<{ gc: bigint | null; gcp: bigint | null }>({
    gc: null,
    gcp: null,
  });
  const [faucetPhase, setFaucetPhase] = useState<FaucetPhase>("idle");
  const [faucetError, setFaucetError] = useState<string | null>(null);

  useEffect(() => {
    if (currentAddress) {
      fetchBalances().then(([gc, gcp]) => setBalances({ gc, gcp }));
    }
  }, [currentAddress, fetchBalances]);

  useEffect(() => {
    if (phase === "link_ready" && currentAddress) {
      fetchBalances().then(([gc, gcp]) => setBalances({ gc, gcp }));
    }
  }, [phase, currentAddress, fetchBalances]);

  const handleOpenFaucet = async () => {
    setFaucetError(null);
    setFaucetPhase("registering");
    try {
      await registerDripContracts();
      setFaucetPhase("awaiting_password");
    } catch (err) {
      setFaucetError(err instanceof Error ? err.message : "Failed to register drip contracts");
      setFaucetPhase("idle");
    }
  };

  const handleDripSubmit = async (password: string) => {
    if (!currentAddress) return;
    setFaucetPhase("dripping");
    try {
      await drip(password, currentAddress);
      const [gc, gcp] = await fetchBalances();
      setBalances({ gc, gcp });
      setFaucetPhase("idle");
    } catch (err) {
      setFaucetError(parseDripError(err));
      setFaucetPhase("awaiting_password");
    }
  };

  const closeDialog = () => {
    if (faucetPhase === "dripping") return; // don't allow close while in-flight
    setFaucetPhase("idle");
    setFaucetError(null);
  };

  return (
    <Box>
      {phase === "link_ready" && generatedLink ? (
        <LinkDisplay
          link={generatedLink}
          amount={amount}
          token={token}
          recipient={recipientAddress}
          onReset={reset}
        />
      ) : (
        <>
          <SendForm
            balance={balances}
            onRequestFaucet={handleOpenFaucet}
            faucetBusy={faucetPhase !== "idle"}
          />
          <SendProgress phase={phase} />
        </>
      )}
      {error && (
        <Alert severity="error" onClose={dismissError} sx={{ mt: 2 }} data-testid="send-error">
          {error}
        </Alert>
      )}
      {faucetError && (
        <Alert severity="error" onClose={() => setFaucetError(null)} sx={{ mt: 2 }}>
          {faucetError}
        </Alert>
      )}
      {currentAddress && <SentHistory senderAddress={currentAddress.toString()} />}

      <Dialog
        open={faucetPhase === "awaiting_password" || faucetPhase === "dripping"}
        onClose={closeDialog}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Get tokens from faucet</DialogTitle>
        <DialogContent>
          {faucetPhase === "dripping" ? (
            <Box
              sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, py: 3 }}
            >
              <CircularProgress size={24} color="primary" />
              <Typography variant="body2" color="text.secondary">
                Claiming tokens...
              </Typography>
            </Box>
          ) : (
            <DripPasswordInput onSubmit={handleDripSubmit} />
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
