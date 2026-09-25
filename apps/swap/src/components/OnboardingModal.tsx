/**
 * OnboardingModal Component
 * Orchestrates the onboarding flow using subcomponents
 */

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  Box,
  Alert,
  Button,
  IconButton,
  Collapse,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useOnboarding } from "../contexts/onboarding";
import { useWallet } from "../contexts/wallet";
import { useNetwork } from "../contexts/network";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import type { Aliased } from "@aztec-labs/aztec.js/wallet";
import type { WalletProvider, PendingConnection } from "@aztec-labs/wallet-sdk/manager";
import { createGoSwapCapabilities } from "../config/capabilities";
import {
  OnboardingProgress,
  WalletDiscovery,
  WalletSelection,
  EmojiVerification,
  AccountSelection,
  ConnectingWallet,
  DripPasswordInput,
  CompletionTransition,
  FlowMessages,
} from "./onboarding";

type WalletConnectionPhase =
  | "discovering"
  | "selecting_wallet"
  | "verifying"
  | "connecting"
  | "selecting_account";

interface OnboardingModalProps {
  open: boolean;
  onAccountSelect: (address: AztecAddress) => void;
}

export function OnboardingModal({ open, onAccountSelect }: OnboardingModalProps) {
  const {
    status,
    error,
    currentStep,
    totalSteps,
    steps,
    resetOnboarding,
    closeModal,
    completeDripOnboarding,
    isSwapPending,
    dripPhase,
    dripError,
    dismissDripError,
    setSimulationGrant,
    hasSimulationGrant,
    selectEmbeddedWallet,
    useEmbeddedWallet,
  } = useOnboarding();
  const {
    discoverWallets,
    initiateConnection,
    confirmConnection,
    cancelConnection,
    onWalletDisconnect,
  } = useWallet();
  const { activeNetwork } = useNetwork();

  // Wallet connection state
  const [accounts, setAccounts] = useState<Aliased<AztecAddress>[]>([]);
  const [isLoadingAccounts, setIsLoadingAccounts] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [connectionPhase, setConnectionPhase] = useState<WalletConnectionPhase>("discovering");
  const [discoveredWallets, setDiscoveredWallets] = useState<WalletProvider[]>([]);
  const [selectedWallet, setSelectedWallet] = useState<WalletProvider | null>(null);
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);
  const [needsRediscovery, setNeedsRediscovery] = useState(false);
  const [cancelledWalletIds, setCancelledWalletIds] = useState<Set<string>>(new Set());

  // Transition animation state
  const [showCompletionCheck, setShowCompletionCheck] = useState(false);
  const [showSwapIcon, setShowSwapIcon] = useState(false);

  const isLoading = status !== "idle" && status !== "completed" && status !== "error";

  // Listen for unexpected wallet disconnection
  useEffect(() => {
    const unsubscribe = onWalletDisconnect(() => {
      setNeedsRediscovery(true);
      setDiscoveredWallets([]);
      setAccounts([]);
      if (status === "connecting") {
        setConnectionPhase("discovering");
        setAccountsError("Wallet disconnected. Please reconnect.");
      }
    });
    return unsubscribe;
  }, [onWalletDisconnect, status]);

  // Start wallet discovery when modal opens and status is connecting
  useEffect(() => {
    if (!open || status !== "connecting") return;

    setConnectionPhase("discovering");
    setDiscoveredWallets([]);
    setSelectedWallet(null);
    setPendingConnection(null);
    setAccounts([]);
    setAccountsError(null);
    setNeedsRediscovery(false);
    setCancelledWalletIds(new Set());

    const discovery = discoverWallets();

    (async () => {
      let foundAny = false;
      for await (const wallet of discovery.wallets) {
        foundAny = true;
        setConnectionPhase("selecting_wallet");
        setDiscoveredWallets((prev) => [...prev, wallet]);
      }
      if (!foundAny) {
        // No external wallets found — still show wallet selection phase so the embedded option is visible
        setConnectionPhase("selecting_wallet");
      }
    })();

    return () => {
      discovery.cancel();
    };
  }, [open, status, discoverWallets]);

  // Handle manual re-discovery
  const handleRediscover = async () => {
    if (pendingConnection) {
      cancelConnection(pendingConnection);
    }

    setConnectionPhase("discovering");
    setDiscoveredWallets([]);
    setSelectedWallet(null);
    setPendingConnection(null);
    setAccounts([]);
    setAccountsError(null);
    setNeedsRediscovery(false);
    setCancelledWalletIds(new Set());

    const discovery = discoverWallets();
    let foundAny = false;
    for await (const wallet of discovery.wallets) {
      foundAny = true;
      setConnectionPhase("selecting_wallet");
      setDiscoveredWallets((prev) => [...prev, wallet]);
    }

    if (!foundAny) {
      // No external wallets found — still show wallet selection phase so the embedded option is visible
      setConnectionPhase("selecting_wallet");
    }
  };

  // Handle wallet selection
  const handleWalletSelect = async (provider: WalletProvider) => {
    try {
      setSelectedWallet(provider);
      setConnectionPhase("verifying");
      setAccountsError(null);

      const pending = await initiateConnection(provider);
      setPendingConnection(pending);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : "Failed to initiate connection");
      setConnectionPhase("selecting_wallet");
      setSelectedWallet(null);
      setPendingConnection(null);
    }
  };

  // Handle emoji verification confirmation
  const handleConfirmConnection = async () => {
    if (!selectedWallet || !pendingConnection) return;

    try {
      setConnectionPhase("connecting");
      setIsLoadingAccounts(true);

      const wallet = await confirmConnection(selectedWallet, pendingConnection);

      // Request capabilities with full manifest (includes account selection)
      const manifest = createGoSwapCapabilities(activeNetwork);
      const capabilitiesResponse = await wallet.requestCapabilities(manifest);

      // Check if simulation capabilities were granted (affects step labels)
      const simulationCapability = capabilitiesResponse.granted.find(
        (cap) => cap.type === "simulation",
      );
      setSimulationGrant(!!simulationCapability);

      // Extract granted accounts from capability response
      const accountsCapability = capabilitiesResponse.granted.find(
        (cap) => cap.type === "accounts",
      ) as
        | ((typeof capabilitiesResponse.granted)[0] & { accounts?: Aliased<AztecAddress>[] })
        | undefined;

      if (
        !accountsCapability ||
        !accountsCapability.accounts ||
        accountsCapability.accounts.length === 0
      ) {
        throw new Error(
          "No accounts were granted. Please select at least one account in your wallet.",
        );
      }

      // Accounts are already in Aliased format from wallet response
      const walletAccounts: Aliased<AztecAddress>[] = accountsCapability.accounts;

      setAccounts(walletAccounts);
      setConnectionPhase("selecting_account");
      setIsLoadingAccounts(false);
      setPendingConnection(null);
    } catch (err) {
      setAccountsError(err instanceof Error ? err.message : "Failed to connect to wallet");
      setConnectionPhase("selecting_wallet");
      setSelectedWallet(null);
      setPendingConnection(null);
      setIsLoadingAccounts(false);
    }
  };

  // Handle emoji verification cancellation
  const handleCancelConnection = () => {
    if (pendingConnection) {
      cancelConnection(pendingConnection);
    }
    if (selectedWallet) {
      setCancelledWalletIds((prev) => new Set(prev).add(selectedWallet.id));
    }
    setPendingConnection(null);
    setSelectedWallet(null);
    setConnectionPhase("selecting_wallet");
  };

  // Handle completion animation and auto-close
  useEffect(() => {
    if (status === "completed" && isSwapPending) {
      setShowCompletionCheck(true);

      const iconTimer = setTimeout(() => {
        setShowSwapIcon(true);
      }, 800);

      const closeTimer = setTimeout(() => {
        closeModal();
      }, 2000);

      return () => {
        clearTimeout(iconTimer);
        clearTimeout(closeTimer);
      };
    } else if (status === "completed" && !isSwapPending) {
      closeModal();
    } else {
      setShowCompletionCheck(false);
      setShowSwapIcon(false);
    }
  }, [status, closeModal, isSwapPending]);

  // Computed display states
  const showWalletSelection = status === "connecting" && connectionPhase === "selecting_wallet";
  const showEmojiVerification =
    status === "connecting" && connectionPhase === "verifying" && pendingConnection !== null;
  const showAccountSelection =
    status === "connecting" && connectionPhase === "selecting_account" && accounts.length > 0;
  const showCompletionTransition = status === "completed";

  return (
    <Dialog
      open={open}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown
      sx={{
        backgroundColor: "background.paper",
        backgroundImage: "none",
      }}
      slotProps={{
        paper: {
          "data-testid": "onboarding-modal",
          "data-status": status,
          "data-drip-phase": dripPhase,
        } as object,
      }}
    >
      <DialogTitle
        sx={{
          fontWeight: 600,
          pb: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        Setting Up Your Wallet
        <IconButton
          onClick={closeModal}
          size="small"
          sx={{
            color: "text.secondary",
            "&:hover": {
              backgroundColor: "rgba(255, 255, 255, 0.08)",
            },
          }}
          aria-label="close"
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent>
        {showCompletionTransition ? (
          <CompletionTransition
            showCheck={showCompletionCheck}
            showActionIcon={showSwapIcon}
            hasPendingSwap={isSwapPending}
          />
        ) : (
          <>
            {/* Progress Bar and Steps */}
            <OnboardingProgress
              currentStep={currentStep}
              totalSteps={totalSteps}
              steps={steps}
              status={status}
              isLoading={isLoading}
            />

            {/* Error Display */}
            {(error || accountsError) && (
              <Alert
                severity="error"
                sx={{ mb: 3 }}
                action={
                  needsRediscovery || accountsError?.includes("disconnected") ? (
                    <Button
                      size="small"
                      color="inherit"
                      startIcon={<RefreshIcon />}
                      onClick={handleRediscover}
                    >
                      Reconnect
                    </Button>
                  ) : (
                    <Button size="small" color="inherit" onClick={resetOnboarding}>
                      Retry
                    </Button>
                  )
                }
              >
                {error || accountsError}
              </Alert>
            )}

            {/* Wallet Connection Flow */}
            <Collapse in={status === "connecting"} timeout={400}>
              <Box sx={{ pl: 5, pr: 2, pb: 2 }}>
                {connectionPhase === "discovering" ? (
                  <WalletDiscovery onUseEmbedded={selectEmbeddedWallet} />
                ) : isLoadingAccounts && connectionPhase === "connecting" && selectedWallet ? (
                  <ConnectingWallet wallet={selectedWallet} />
                ) : showWalletSelection ? (
                  <WalletSelection
                    wallets={discoveredWallets}
                    cancelledWalletIds={cancelledWalletIds}
                    onSelect={handleWalletSelect}
                    onRefresh={handleRediscover}
                    onUseEmbedded={selectEmbeddedWallet}
                  />
                ) : showEmojiVerification && selectedWallet && pendingConnection ? (
                  <EmojiVerification
                    wallet={selectedWallet}
                    pendingConnection={pendingConnection}
                    onConfirm={handleConfirmConnection}
                    onCancel={handleCancelConnection}
                  />
                ) : showAccountSelection ? (
                  <AccountSelection accounts={accounts} onSelect={onAccountSelect} />
                ) : null}
              </Box>
            </Collapse>

            {/* Flow-specific Messages */}
            <FlowMessages
              status={status}
              hasSimulationGrant={hasSimulationGrant}
              useEmbeddedWallet={useEmbeddedWallet}
            />

            {/* Drip Password Input (shown when balance is 0) */}
            <Collapse in={status === "awaiting_drip"} timeout={400}>
              {status === "awaiting_drip" && (
                <DripPasswordInput onSubmit={completeDripOnboarding} />
              )}
            </Collapse>

            {/* Drip Error Display (shown when drip fails during execution) */}
            <Collapse in={status === "executing_drip" && dripPhase === "error"} timeout={400}>
              {status === "executing_drip" && dripPhase === "error" && (
                <Box sx={{ mt: 3 }}>
                  <Alert
                    severity="error"
                    sx={{ mb: 2 }}
                    action={
                      <Button size="small" color="inherit" onClick={dismissDripError}>
                        Retry
                      </Button>
                    }
                  >
                    {dripError || "Failed to claim tokens. Please try again."}
                  </Alert>
                  <DripPasswordInput onSubmit={completeDripOnboarding} />
                </Box>
              )}
            </Collapse>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
