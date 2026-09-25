/**
 * ConnectingWallet Component
 * Shows wallet info with emoji while connection is being established
 */

import { Box, Typography, CircularProgress } from "@mui/material";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import SecurityIcon from "@mui/icons-material/Security";
import type { WalletProvider } from "@aztec-labs/wallet-sdk/manager";
import { hashToEmoji } from "@aztec-labs/wallet-sdk/crypto";

interface ConnectingWalletProps {
  wallet: WalletProvider;
}

/** Computes verification emoji from provider metadata */
function getVerificationEmoji(provider: WalletProvider): string {
  return provider.metadata?.verificationHash
    ? hashToEmoji(provider.metadata.verificationHash as string)
    : "";
}

export function ConnectingWallet({ wallet }: ConnectingWalletProps) {
  return (
    <>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          p: 2,
          border: "1px solid",
          borderColor: "primary.main",
          borderRadius: 1,
          backgroundColor: "rgba(212, 255, 40, 0.05)",
          mb: 2,
        }}
      >
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
        <Box sx={{ flex: 1 }}>
          <Typography variant="body1" fontWeight={600}>
            {wallet.name}
          </Typography>
          {getVerificationEmoji(wallet) && (
            <Typography variant="body2" sx={{ letterSpacing: "0.15em", mt: 0.5 }}>
              {getVerificationEmoji(wallet)}
            </Typography>
          )}
        </Box>
        <CircularProgress size={24} sx={{ color: "primary.main" }} />
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
          Verify the emoji code matches what your wallet is showing.
        </Typography>
      </Box>

      <Typography variant="body2" color="text.secondary" textAlign="center">
        Connecting and retrieving accounts...
      </Typography>
      <Typography textAlign="center" sx={{ alignSelf: "center", mt: 0.5 }}>
        Please approve the request in your wallet
      </Typography>
    </>
  );
}
