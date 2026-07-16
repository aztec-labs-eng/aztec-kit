import { Box, TextField, Typography, ToggleButton, ToggleButtonGroup, Button } from "@mui/material";
import WaterDropIcon from "@mui/icons-material/WaterDrop";
import { useSend } from "../../contexts/send";

interface SendFormProps {
  balance: { gc: bigint | null; gcp: bigint | null };
  onRequestFaucet: () => void;
  faucetBusy: boolean;
}

export function SendForm({ balance, onRequestFaucet, faucetBusy }: SendFormProps) {
  const {
    token,
    deliveryMode,
    recipientAddress,
    amount,
    phase,
    setToken,
    setDeliveryMode,
    setRecipientAddress,
    setAmount,
    canSend,
    onchainSupported,
    executeSend,
  } = useSend();
  const isSending = phase === "sending" || phase === "generating_link";
  const currentBalance = token === "gc" ? balance.gc : balance.gcp;
  const selectedTokenIsEmpty = currentBalance === 0n;
  const submitLabel = isSending
    ? "Sending..."
    : deliveryMode === "onchain"
      ? "Send"
      : "Send & Generate Link";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: "block" }}>
          Token
        </Typography>
        <ToggleButtonGroup
          value={token}
          exclusive
          onChange={(_, v) => v && setToken(v)}
          size="small"
          fullWidth
          disabled={isSending}
        >
          <ToggleButton value="gc">GoCoin</ToggleButton>
          <ToggleButton value="gcp">GoCoinPremium</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: "block" }}>
          Delivery
        </Typography>
        <ToggleButtonGroup
          value={deliveryMode}
          exclusive
          onChange={(_, v) => v && setDeliveryMode(v)}
          size="small"
          fullWidth
          disabled={isSending}
          data-testid="send-delivery-mode"
        >
          <ToggleButton value="offchain" data-testid="send-delivery-offchain">
            Off-chain link
          </ToggleButton>
          <ToggleButton
            value="onchain"
            data-testid="send-delivery-onchain"
            disabled={!onchainSupported}
          >
            On-chain private channel
          </ToggleButton>
        </ToggleButtonGroup>
        {!onchainSupported && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
            On-chain delivery isn't sponsored on this network yet.
          </Typography>
        )}
      </Box>
      <TextField
        label="Recipient Address"
        placeholder="0x..."
        value={recipientAddress}
        onChange={(e) => setRecipientAddress(e.target.value)}
        fullWidth
        disabled={isSending}
        size="small"
        slotProps={{ htmlInput: { "data-testid": "send-recipient-input" } }}
      />
      <Box>
        <TextField
          label="Amount"
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          fullWidth
          disabled={isSending}
          size="small"
          slotProps={{
            htmlInput: { "data-testid": "send-amount-input" },
            input: {
              endAdornment:
                currentBalance !== null ? (
                  <Typography
                    data-testid="send-balance"
                    variant="caption"
                    color="text.secondary"
                    sx={{ whiteSpace: "nowrap" }}
                  >
                    Balance: {currentBalance.toString()}
                  </Typography>
                ) : null,
            },
          }}
        />
      </Box>
      {selectedTokenIsEmpty && (
        <Button
          variant="outlined"
          fullWidth
          disabled={faucetBusy || isSending}
          onClick={onRequestFaucet}
          startIcon={<WaterDropIcon />}
          sx={{ mt: 1 }}
        >
          {faucetBusy ? "Preparing faucet..." : "Get tokens from faucet"}
        </Button>
      )}
      <Button
        variant="contained"
        fullWidth
        disabled={!canSend || isSending}
        onClick={executeSend}
        data-testid="send-submit"
        sx={{ mt: 1, fontWeight: "bold" }}
      >
        {submitLabel}
      </Button>
    </Box>
  );
}
