import { Box, Typography, Button } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";

interface SentConfirmationProps {
  amount: string;
  token: "gc" | "gcp";
  recipient: string;
  onReset: () => void;
}

/**
 * Terminal view for an on-chain private send: there is no claim link — the
 * recipient's note was delivered on-chain and they discover it by scanning.
 */
export function SentConfirmation({ amount, token, recipient, onReset }: SentConfirmationProps) {
  const tokenName = token === "gc" ? "GoCoin" : "GoCoinPremium";
  return (
    <Box
      data-testid="send-confirmation"
      sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, py: 2 }}
    >
      <CheckCircleOutlineIcon color="primary" sx={{ fontSize: 48 }} />
      <Typography variant="h5" color="primary" sx={{ fontWeight: "bold" }}>
        Sent!
      </Typography>
      <Typography color="text.secondary">
        {amount} {tokenName} → {recipient.slice(0, 8)}...{recipient.slice(-4)}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ textAlign: "center" }}>
        Delivered on-chain. The recipient will discover the tokens on their next sync — no link to
        share.
      </Typography>
      <Button variant="outlined" fullWidth onClick={onReset} sx={{ mt: 1 }}>
        Send another
      </Button>
    </Box>
  );
}
