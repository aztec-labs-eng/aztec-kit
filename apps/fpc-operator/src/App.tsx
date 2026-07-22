import { useState, useCallback } from "react";
import {
  ThemeProvider,
  CssBaseline,
  Container,
  Box,
  Typography,
  Paper,
  Chip,
  Tooltip,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { shortAddress } from "@aztec-kit/common/ui";
import { theme } from "./theme";
import { useWallet } from "./contexts/WalletContext";
import { getStoredFPC, loadExistingFPC } from "./services/fpcService";
import { SetupWizard } from "./components/SetupWizard";
import { Dashboard } from "./components/Dashboard";
import { TxNotificationCenter } from "@aztec-kit/embedded-wallet/ui";
import { GoFPCLogo } from "./components/GoFPCLogo";
import { NetworkSwitcher } from "@aztec-kit/common/ui";
import { useNetwork } from "./contexts/NetworkContext";
import type { SubscriptionFPCContract } from "@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC";

export function App() {
  const { wallet, address, node } = useWallet();
  const [fpc, setFpc] = useState<SubscriptionFPCContract | null>(null);
  const [fpcAddress, setFpcAddress] = useState<string | null>(null);

  const handleSetupComplete = useCallback(
    async (addr: string) => {
      if (!wallet || !node) return;
      setFpcAddress(addr);
      try {
        const stored = getStoredFPC();
        if (!stored) return;
        const loaded = await loadExistingFPC(wallet, node, stored);
        setFpc(loaded);
      } catch (err) {
        console.error("Failed to load FPC:", err);
      }
    },
    [wallet, node],
  );

  const setupComplete = !!fpc && !!address && !!fpcAddress;

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <NetworkSwitcher
        useNetwork={useNetwork}
        onSwitch={(_next, _current, commit) => {
          commit();
          // Reload to reinitialize the wallet context against the new network.
          window.location.reload();
        }}
      />
      <Box
        sx={{
          minHeight: "100vh",
          backgroundColor: "background.default",
          py: 4,
          position: "relative",
          overflow: "hidden",
          "&::before": {
            content: '""',
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundImage: "url(/background.jpg)",
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundRepeat: "no-repeat",
            filter: "grayscale(60%) brightness(0.5) contrast(0.8) saturate(0.8)",
            opacity: 0.6,
            zIndex: 0,
          },
        }}
      >
        <Container maxWidth="md" sx={{ position: "relative", zIndex: 1 }}>
          {/* Header */}
          <Box sx={{ textAlign: "center", mb: 4, mt: 4 }}>
            <Box sx={{ display: "flex", justifyContent: "center", mb: 2 }}>
              <GoFPCLogo height={56} />
            </Box>
            <Typography variant="body1" color="text.secondary">
              FPC Operator Dashboard
            </Typography>
          </Box>

          {/* Status chips */}
          <Box
            sx={{
              display: "flex",
              justifyContent: "center",
              gap: 1,
              mb: 3,
              flexWrap: "wrap",
            }}
          >
            {address && (
              <Tooltip title="Copy admin address">
                <Chip
                  label={`Admin: ${shortAddress(address.toString())}`}
                  size="small"
                  color="primary"
                  variant="outlined"
                  icon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
                  onClick={() => navigator.clipboard.writeText(address.toString())}
                />
              </Tooltip>
            )}
            {fpcAddress && (
              <Tooltip title="Copy FPC address">
                <Chip
                  label={`FPC: ${shortAddress(fpcAddress)}`}
                  size="small"
                  color="success"
                  variant="outlined"
                  icon={<ContentCopyIcon sx={{ fontSize: 14 }} />}
                  onClick={() => navigator.clipboard.writeText(fpcAddress)}
                />
              </Tooltip>
            )}
          </Box>

          <Paper sx={{ p: 3 }}>
            {!setupComplete ? (
              <SetupWizard onComplete={handleSetupComplete} onFpcAddressComputed={setFpcAddress} />
            ) : (
              <Dashboard fpc={fpc} adminAddress={address} fpcAddress={fpcAddress} />
            )}
          </Paper>

          {/* Footer */}
          <Box sx={{ textAlign: "center", mt: 4, mb: 2 }}>
            <Typography variant="body2" sx={{ color: "rgba(242, 238, 225, 0.4)" }}>
              Deploy and manage Subscription FPC contracts for sponsoring user transactions on
              Aztec.
            </Typography>
            <Typography variant="caption" sx={{ color: "rgba(242, 238, 225, 0.3)" }}>
              {__AZTEC_VERSION__}
            </Typography>
          </Box>
        </Container>
      </Box>

      <TxNotificationCenter account={address?.toString()} />
    </ThemeProvider>
  );
}
