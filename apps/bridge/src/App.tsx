import { ThemeProvider, CssBaseline, Container, Box, Typography } from "@mui/material";
import { NetworkSwitcher } from "@aztec-kit/common/ui";
import { theme } from "./theme";
import { WalletChip } from "./components/WalletChip";
import { useNetwork } from "./contexts/NetworkContext";
import { BridgeWizard } from "./components/BridgeWizard";
import { GoBridgeLogo } from "./components/GoBridgeLogo";
import { TxNotificationCenter } from "@aztec-kit/embedded-wallet/ui";
import { useAztecWallet } from "./contexts/AztecWalletContext";
import { getQueryParams } from "./config/query-params";

const { isIframe } = getQueryParams();

export function App() {
  const { address: aztecAddress } = useAztecWallet();

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box
        sx={{
          minHeight: isIframe ? undefined : "100vh",
          backgroundColor: "background.default",
          py: isIframe ? 2 : 4,
          position: "relative",
          overflow: "hidden",
          ...(!isIframe && {
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
          }),
        }}
      >
        {!isIframe && <NetworkSwitcher useNetwork={useNetwork} />}
        {!isIframe && <WalletChip />}

        <Container maxWidth="sm" sx={{ position: "relative", zIndex: 1 }}>
          {/* Header (hidden in iframe mode) */}
          {!isIframe && (
            <Box sx={{ textAlign: "center", mb: 6, mt: 4 }}>
              <Box sx={{ display: "flex", justifyContent: "center", mb: 2 }}>
                <GoBridgeLogo height={56} />
              </Box>
              <Typography variant="body1" color="text.secondary">
                Bridge fee juice to any Aztec address
              </Typography>
            </Box>
          )}

          {/* Bridge Form */}
          <BridgeWizard />

          {/* Footer (hidden in iframe mode) */}
          {!isIframe && (
            <Box sx={{ textAlign: "center", mt: 4, mb: 2 }}>
              <Typography variant="body2" sx={{ color: "rgba(242, 238, 225, 0.4)" }}>
                Bridges $AZTEC from L1 to Aztec L2 via the FeeJuicePortal.
                <br />
                On testnet, tokens are minted for free via the faucet.
              </Typography>
              <Typography variant="caption" sx={{ color: "rgba(242, 238, 225, 0.3)" }}>
                {__AZTEC_VERSION__}
              </Typography>
            </Box>
          )}
        </Container>
      </Box>

      {/* Transaction Progress Toasts (embedded Aztec wallet only) */}
      <TxNotificationCenter account={aztecAddress?.toString()} />
    </ThemeProvider>
  );
}
