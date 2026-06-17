import { useState, useEffect } from "react";
import { Box, Typography, LinearProgress, Alert, Button } from "@mui/material";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import SecurityIcon from "@mui/icons-material/Security";
import { useNetwork } from "../../../contexts/NetworkContext";
import { useAztecWallet } from "../../../contexts/AztecWalletContext";
import { getAztecNode } from "../../../services";
import {
  WalletManager,
  type WalletProvider,
  type PendingConnection,
} from "@aztec/wallet-sdk/manager";
import { hashToEmoji } from "@aztec/wallet-sdk/crypto";
import { Fr } from "@aztec/foundation/curves/bn254";

const WEB_WALLET_URLS: string[] = [import.meta.env.VITE_WEB_WALLET_URL ?? "http://localhost:3001"];

// ── Emoji Grid (inline, small enough to not warrant its own file) ────

function EmojiGrid({ emojis }: { emojis: string }) {
  const emojiArray = [...emojis];
  const rows = [emojiArray.slice(0, 3), emojiArray.slice(3, 6), emojiArray.slice(6, 9)];
  return (
    <Box sx={{ display: "inline-flex", flexDirection: "column", gap: "2px" }}>
      {rows.map((row, i) => (
        <Box key={i} sx={{ display: "flex", gap: "2px" }}>
          {row.map((emoji, j) => (
            <Box
              key={j}
              sx={{
                fontSize: "1.8rem",
                width: "1.2em",
                height: "1.2em",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {emoji}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

// ── Main Component ───────────────────────────────────────────────────

export function ExternalWalletConnect() {
  const { activeNetwork } = useNetwork();
  const { connectExternalWallet } = useAztecWallet();

  const [discovered, setDiscovered] = useState<WalletProvider[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Emoji verification state
  const [pendingProvider, setPendingProvider] = useState<WalletProvider | null>(null);
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null);

  // ── Discovery ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setIsDiscovering(true);
    (async () => {
      try {
        const node = getAztecNode(activeNetwork.aztecNodeUrl, activeNetwork.apiKey);
        const nodeInfo = await node.getNodeInfo();
        const chainInfo = {
          chainId: Fr.fromString(nodeInfo.l1ChainId.toString()),
          version: Fr.fromString(nodeInfo.rollupVersion.toString()),
        };
        const session = WalletManager.configure({
          extensions: { enabled: true },
          webWallets: { urls: WEB_WALLET_URLS },
        }).getAvailableWallets({
          chainInfo,
          appId: "gobridge",
          timeout: 5000,
        });
        const wallets: WalletProvider[] = [];
        for await (const provider of session.wallets) {
          if (cancelled) break;
          wallets.push(provider);
          setDiscovered([...wallets]);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "Wallet discovery failed");
      } finally {
        if (!cancelled) setIsDiscovering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeNetwork]);

  // ── Step 1: Initiate connection (shows emojis) ─────────────────────
  const handleInitiate = async (provider: WalletProvider) => {
    setIsConnecting(true);
    setErr(null);
    try {
      const pending = await provider.establishSecureChannel("gobridge");
      setPendingProvider(provider);
      setPendingConnection(pending);
      setIsConnecting(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Connection failed");
      setIsConnecting(false);
    }
  };

  // ── Step 2: Confirm after emoji verification ───────────────────────
  const handleConfirm = async () => {
    if (!pendingConnection) return;
    setIsConnecting(true);
    setErr(null);
    try {
      const wallet = await pendingConnection.confirm();
      const accounts = await wallet.getAccounts();
      if (accounts.length === 0) throw new Error("No accounts available");
      await connectExternalWallet(wallet, accounts[0].item);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Connection failed");
    } finally {
      setPendingProvider(null);
      setPendingConnection(null);
      setIsConnecting(false);
    }
  };

  const handleCancel = () => {
    if (pendingConnection) {
      try {
        pendingConnection.cancel();
      } catch {
        /* ignore */
      }
    }
    setPendingProvider(null);
    setPendingConnection(null);
    setIsConnecting(false);
  };

  // ── Render: Emoji verification step ────────────────────────────────
  if (pendingConnection && pendingProvider) {
    return (
      <Box>
        <Box
          sx={{
            p: 2,
            border: "1px solid",
            borderColor: "primary.main",
            backgroundColor: "rgba(212, 255, 40, 0.05)",
            mb: 2,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2 }}>
            {pendingProvider.icon ? (
              <Box
                component="img"
                src={pendingProvider.icon}
                alt={pendingProvider.name}
                sx={{ width: 40, height: 40 }}
              />
            ) : (
              <AccountBalanceWalletIcon sx={{ fontSize: 32, color: "primary.main" }} />
            )}
            <Typography variant="body1" fontWeight={600}>
              {pendingProvider.name}
            </Typography>
          </Box>

          <Box
            sx={{
              p: 2,
              backgroundColor: "rgba(0, 0, 0, 0.2)",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <EmojiGrid emojis={hashToEmoji(pendingConnection.verificationHash)} />
          </Box>
        </Box>

        <Box
          sx={{
            p: 1.5,
            backgroundColor: "rgba(33, 150, 243, 0.08)",
            border: "1px solid rgba(33, 150, 243, 0.3)",
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
            Verify the emoji code above matches what your wallet is showing.
          </Typography>
        </Box>

        <Box sx={{ display: "flex", gap: 2 }}>
          <Button variant="outlined" color="inherit" onClick={handleCancel} sx={{ flex: 1 }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={handleConfirm}
            disabled={isConnecting}
            sx={{ flex: 1 }}
          >
            {isConnecting ? "Connecting..." : "Emojis Match"}
          </Button>
        </Box>
      </Box>
    );
  }

  // ── Render: Discovery / wallet list ────────────────────────────────
  if (isDiscovering) {
    return (
      <Box sx={{ py: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
          Discovering wallets...
        </Typography>
        <LinearProgress />
      </Box>
    );
  }

  if (isConnecting) {
    return (
      <Box sx={{ py: 1 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
          Connecting...
        </Typography>
        <LinearProgress />
      </Box>
    );
  }

  return (
    <Box>
      {discovered.length === 0 && (
        <Alert severity="info" sx={{ borderRadius: 0 }}>
          No wallets found. Make sure your Aztec wallet extension is installed.
        </Alert>
      )}
      {discovered.map((w) => (
        <Button
          key={w.id}
          fullWidth
          variant="outlined"
          color="primary"
          onClick={() => handleInitiate(w)}
          sx={{
            mb: 1,
            justifyContent: "flex-start",
            textTransform: "none",
            gap: 1,
          }}
        >
          {w.icon && <Box component="img" src={w.icon} alt="" sx={{ width: 20, height: 20 }} />}
          {w.name}
        </Button>
      ))}
      {err && (
        <Alert severity="error" sx={{ mt: 1, borderRadius: 0 }}>
          {err}
        </Alert>
      )}
    </Box>
  );
}
