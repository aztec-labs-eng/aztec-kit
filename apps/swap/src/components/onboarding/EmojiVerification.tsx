/**
 * EmojiVerification Component
 * Shows emoji verification UI for wallet connection
 */

import { Box, Typography, Button } from "@mui/material";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import SecurityIcon from "@mui/icons-material/Security";
import type { WalletProvider, PendingConnection } from "@aztec-labs/wallet-sdk/manager";
import { hashToEmoji } from "@aztec-labs/wallet-sdk/crypto";
import { EmojiGrid } from "./EmojiGrid";

interface EmojiVerificationProps {
  wallet: WalletProvider;
  pendingConnection: PendingConnection;
  onConfirm: () => void;
  onCancel: () => void;
}

export function EmojiVerification({
  wallet,
  pendingConnection,
  onConfirm,
  onCancel,
}: EmojiVerificationProps) {
  return (
    <>
      <Box
        sx={{
          p: 2,
          border: "1px solid",
          borderColor: "primary.main",
          borderRadius: 1,
          backgroundColor: "rgba(212, 255, 40, 0.05)",
          mb: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2 }}>
          {wallet.icon ? (
            <Box
              component="img"
              src={wallet.icon}
              alt={wallet.name}
              sx={{ width: 40, height: 40, borderRadius: 1 }}
            />
          ) : (
            <Box
              sx={{
                width: 40,
                height: 40,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: "rgba(255, 255, 255, 0.1)",
                borderRadius: 1,
              }}
            >
              <AccountBalanceWalletIcon sx={{ fontSize: 24, color: "primary.main" }} />
            </Box>
          )}
          <Typography variant="body1" fontWeight={600}>
            {wallet.name}
          </Typography>
        </Box>

        {/* Verification emoji display */}
        <Box
          sx={{
            p: 2,
            backgroundColor: "rgba(0, 0, 0, 0.2)",
            borderRadius: 1,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <EmojiGrid emojis={hashToEmoji(pendingConnection.verificationHash)} size="large" />
        </Box>
      </Box>

      <Box
        sx={{
          p: 1.5,
          backgroundColor: "rgba(33, 150, 243, 0.08)",
          borderRadius: 1,
          border: "1px solid",
          borderColor: "rgba(33, 150, 243, 0.3)",
          mb: 2,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
          <SecurityIcon sx={{ fontSize: 18, color: "info.main" }} />
          <Typography variant="body2" fontWeight={600} color="info.main">
            Security Verification
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">
          Verify the emoji code above matches what your wallet is showing. If they don't match,
          click "Cancel" - someone may be trying to intercept your connection.
        </Typography>
      </Box>

      <Box sx={{ display: "flex", gap: 2 }}>
        <Button variant="outlined" color="inherit" onClick={onCancel} sx={{ flex: 1 }}>
          Cancel
        </Button>
        <Button variant="contained" color="primary" onClick={onConfirm} sx={{ flex: 1 }}>
          Emojis Match
        </Button>
      </Box>
    </>
  );
}
