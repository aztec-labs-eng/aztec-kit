import { useState, useEffect } from "react";
import {
  ThemeProvider,
  CssBaseline,
  Container,
  Box,
  Typography,
  Tabs,
  Tab,
  Snackbar,
} from "@mui/material";
import { theme } from "./theme";
import { GoSwapLogo } from "./components/GoSwapLogo";
import { WalletChip } from "./components/WalletChip";
import { NetworkSwitcher } from "./components/NetworkSwitcher";
import { FooterInfo } from "./components/FooterInfo";
import { SwapContainer } from "./components/swap";
import { SendContainer } from "./components/send/SendContainer";
import { ClaimPage } from "./components/claim/ClaimPage";
import { isClaimRoute } from "./services/offchainLinkService";
import { useWallet } from "./contexts/wallet";
import { useOnboarding } from "./contexts/onboarding";
import { OnboardingModal } from "./components/OnboardingModal";
import { TxNotificationCenter } from "@aztec-kit/embedded-wallet/ui";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { lazy, Suspense } from "react";

// Dev-only lazy import so ProfilePanel + its deps (canvas flame chart) are
// tree-shaken from prod builds. `import.meta.env.DEV` is replaced with the
// literal boolean at build time; in prod the `?:` picks `null`.
const ProfilePanel = import.meta.env.DEV
  ? lazy(() => import("./components/ProfilePanel").then((m) => ({ default: m.ProfilePanel })))
  : null;

export function App() {
  const [activeTab, setActiveTab] = useState(0);
  const [addressCopied, setAddressCopied] = useState(false);
  const [onClaimRoute, setOnClaimRoute] = useState(isClaimRoute);
  const {
    disconnectWallet,
    setCurrentAddress,
    currentAddress,
    error: walletError,
    isLoading: walletLoading,
  } = useWallet();
  const {
    isOnboardingModalOpen,
    startOnboarding,
    resetOnboarding,
    status: onboardingStatus,
  } = useOnboarding();

  // Re-evaluate the claim route whenever the URL hash changes so that pasting a claim
  // link into an already-loaded tab (or clicking an in-app link) routes correctly.
  useEffect(() => {
    const handler = () => setOnClaimRoute(isClaimRoute());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const isOnboarded = onboardingStatus === "completed";

  const handleWalletClick = async () => {
    // If connected, copy the address. Otherwise start onboarding.
    if (isOnboarded && currentAddress) {
      await navigator.clipboard.writeText(currentAddress.toString());
      setAddressCopied(true);
      return;
    }
    startOnboarding();
  };

  const handleDisconnect = async () => {
    await disconnectWallet();
    resetOnboarding();
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
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
        {/* Network Switcher */}
        <NetworkSwitcher />

        {/* Wallet Connection Chip */}
        <WalletChip
          address={currentAddress?.toString() || null}
          isConnected={isOnboarded && currentAddress !== null}
          onClick={handleWalletClick}
          onDisconnect={handleDisconnect}
        />
        <Snackbar
          open={addressCopied}
          autoHideDuration={2000}
          onClose={() => setAddressCopied(false)}
          message="Address copied!"
        />

        <Container maxWidth="sm" sx={{ position: "relative", zIndex: 1 }}>
          {onClaimRoute ? (
            <ClaimPage
              onClaimComplete={() => {
                setActiveTab(1); // land on the Send tab after claiming
                window.location.hash = "";
              }}
            />
          ) : (
            <>
              {/* Header */}
              <Box sx={{ textAlign: "center", mb: 6, mt: 4 }}>
                <Box sx={{ display: "flex", justifyContent: "center", mb: 2 }}>
                  <GoSwapLogo height={56} />
                </Box>
                <Typography variant="body1" color="text.secondary">
                  Swap GoCoin for GoCoinPremium
                </Typography>
              </Box>

              {/* Tab Bar */}
              <Tabs
                value={activeTab}
                onChange={(_, value) => setActiveTab(value)}
                centered
                sx={{
                  mb: 3,
                  "& .MuiTab-root": { color: "text.secondary", fontWeight: 600 },
                  "& .Mui-selected": { color: "primary.main" },
                  "& .MuiTabs-indicator": { backgroundColor: "primary.main" },
                }}
              >
                <Tab label="Swap" />
                <Tab label="Send" />
              </Tabs>

              {/* Tab Content */}
              {activeTab === 0 && <SwapContainer />}
              {activeTab === 1 && <SendContainer />}

              {/* Wallet Error Display */}
              {walletError && (
                <Box sx={{ mt: 3 }}>
                  <Box
                    sx={{
                      p: 3,
                      backgroundColor: "rgba(211, 47, 47, 0.1)",
                      border: "1px solid rgba(211, 47, 47, 0.3)",
                      borderRadius: 1,
                    }}
                  >
                    <Typography variant="h6" color="error" sx={{ mb: 1, fontWeight: 600 }}>
                      Wallet Connection Error
                    </Typography>
                    <Typography variant="body2" color="error" sx={{ whiteSpace: "pre-line" }}>
                      {walletError}
                    </Typography>
                  </Box>
                </Box>
              )}

              {/* Loading Display */}
              {walletLoading && !walletError && (
                <Box sx={{ mt: 3 }}>
                  <Box
                    sx={{
                      p: 3,
                      backgroundColor: "rgba(212, 255, 40, 0.05)",
                      border: "1px solid rgba(212, 255, 40, 0.2)",
                      borderRadius: 1,
                      textAlign: "center",
                    }}
                  >
                    <Typography variant="body2" color="text.secondary">
                      Connecting to network...
                    </Typography>
                  </Box>
                </Box>
              )}

              {/* Footer Info */}
              <FooterInfo />
            </>
          )}
        </Container>
      </Box>

      {/* Onboarding Modal - Handles the full onboarding flow */}
      <OnboardingModal
        open={isOnboardingModalOpen}
        onAccountSelect={(address: AztecAddress) => {
          setCurrentAddress(address);
        }}
      />

      {/* Transaction Progress Toasts (embedded wallet only) */}
      <TxNotificationCenter account={currentAddress?.toString()} />

      {/* Performance profiling panel — dev only (zone.js async-context tracking
          requires transpiled async/await which we enable only in dev mode). */}
      {ProfilePanel && (
        <Suspense fallback={null}>
          <ProfilePanel />
        </Suspense>
      )}
    </ThemeProvider>
  );
}
