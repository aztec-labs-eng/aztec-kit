import { Box, Typography, Button, Chip } from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";

interface ClaimSuccessProps {
  amount: string;
  tokenName: string;
  verified: boolean;
  onGoToSend: () => void;
}

export function ClaimSuccess({ amount, tokenName, verified, onGoToSend }: ClaimSuccessProps) {
  return (
    <Box
      data-testid="claim-success"
      data-verified={verified ? "true" : "false"}
      sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, py: 3 }}
    >
      <CheckCircleIcon sx={{ fontSize: 48, color: "primary.main" }} />
      <Typography variant="h5" color="primary" sx={{ fontWeight: "bold" }}>
        Tokens Claimed!
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="h6" color="text.primary">
          {amount} {tokenName}
        </Typography>
        <Chip
          label={verified ? "Verified" : "Verifying..."}
          size="small"
          color={verified ? "success" : "default"}
          variant="outlined"
        />
      </Box>
      <Button variant="contained" onClick={onGoToSend} sx={{ mt: 2, fontWeight: "bold" }}>
        Back to app →
      </Button>
    </Box>
  );
}
