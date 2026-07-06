import { Box, Typography, Button, IconButton, Snackbar } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

interface LinkDisplayProps {
  link: string;
  amount: string;
  token: "gc" | "gcp";
  recipient: string;
  onReset: () => void;
}

export function LinkDisplay({ link, amount, token, recipient, onReset }: LinkDisplayProps) {
  const [copied, setCopied] = useState(false);
  const tokenName = token === "gc" ? "GoCoin" : "GoCoinPremium";

  const handleCopy = async () => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <Typography variant="h5" color="primary" sx={{ fontWeight: "bold" }}>
        Sent!
      </Typography>
      <Typography color="text.secondary">
        {amount} {tokenName} → {recipient.slice(0, 8)}...{recipient.slice(-4)}
      </Typography>
      <Box
        sx={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 1,
          p: 1,
          bgcolor: "rgba(0,0,0,0.3)",
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 1,
        }}
      >
        <Typography
          variant="body2"
          data-testid="send-link"
          sx={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "text.secondary",
          }}
        >
          {link}
        </Typography>
        <IconButton onClick={handleCopy} size="small" color="primary">
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Box>
      <Box sx={{ p: 2, bgcolor: "#fff", borderRadius: 2 }}>
        <QRCodeSVG value={link} size={160} />
      </Box>
      <Typography variant="caption" color="text.secondary">
        Scan to claim
      </Typography>
      <Button variant="outlined" fullWidth onClick={onReset} sx={{ mt: 1 }}>
        Send another
      </Button>
      <Snackbar
        open={copied}
        autoHideDuration={2000}
        onClose={() => setCopied(false)}
        message="Link copied!"
      />
    </Box>
  );
}
