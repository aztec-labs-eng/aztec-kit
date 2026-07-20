import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { type EIP1193Provider, type Hex } from "viem";
import {
  connectWallet,
  getConnectedAccount,
  switchChain,
  getWalletChainId,
  requestAccountSwitch,
  revokeWalletPermissions,
  subscribeWallets,
  getWalletsSnapshot,
  type EIP6963ProviderDetail,
} from "../services";
import { useNetwork } from "./NetworkContext";
import { WalletPickerDialog } from "../components/WalletPickerDialog";

/** localStorage key holding the rdns of the last-connected wallet. */
const STORAGE_KEY = "gobridge:l1-wallet-rdns";

interface WalletContextType {
  account: Hex | null;
  chainId: number | null;
  /** True while connecting or switching chains */
  isConnecting: boolean;
  /** True when the wallet is on the wrong chain */
  wrongChain: boolean;
  error: string | null;
  /** All browser wallets discovered via EIP-6963 */
  availableWallets: EIP6963ProviderDetail[];
  /** The wallet the user selected, null when disconnected */
  activeWallet: EIP6963ProviderDetail | null;
  /** EIP-1193 provider of the selected wallet — pass to L1 service calls */
  provider: EIP1193Provider | null;
  /** Connects: directly when one wallet is installed, via picker when several */
  connect: () => Promise<void>;
  /** Opens the wallet's account picker to switch accounts */
  switchAccount: () => Promise<void>;
  /** Disconnects the wallet (revokes permission if supported) */
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used within a WalletProvider");
  return context;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { activeNetwork } = useNetwork();
  const availableWallets = useSyncExternalStore(subscribeWallets, getWalletsSnapshot);
  const [selectedRdns, setSelectedRdns] = useState<string | null>(null);
  const [account, setAccount] = useState<Hex | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive the active wallet from the live list so re-announcements stay in sync
  const activeWallet = useMemo(
    () => availableWallets.find((w) => w.info.rdns === selectedRdns) ?? null,
    [availableWallets, selectedRdns],
  );
  const provider = activeWallet?.provider ?? null;

  const expectedChainId = activeNetwork.l1ChainId;
  const wrongChain = chainId != null && chainId !== expectedChainId;

  // ── Silent reconnect to the last-used wallet ───────────────────────
  // Waits for the stored wallet to announce itself (extensions can
  // initialize after page load), then restores the session only if the
  // wallet still reports a connected account.
  useEffect(() => {
    if (selectedRdns) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const wallet = availableWallets.find((w) => w.info.rdns === stored);
    if (!wallet) return;
    let cancelled = false;
    (async () => {
      const addr = await getConnectedAccount(wallet.provider);
      if (cancelled || !addr) return;
      setSelectedRdns(wallet.info.rdns);
      setAccount(addr);
      const id = await getWalletChainId(wallet.provider);
      if (!cancelled && id != null) setChainId(id);
    })();
    return () => {
      cancelled = true;
    };
  }, [availableWallets, selectedRdns]);

  // ── Listen for account/chain changes on the SELECTED provider ─────
  useEffect(() => {
    if (!provider) return;

    const handleAccountsChanged = (accounts: readonly Hex[]) => {
      setAccount(accounts[0] ?? null);
      setError(null);
    };

    const handleChainChanged = (chainIdHex: string) => {
      setChainId(parseInt(chainIdHex, 16));
      setError(null);
    };

    const handleDisconnect = () => {
      setAccount(null);
      setChainId(null);
    };

    provider.on("accountsChanged", handleAccountsChanged);
    provider.on("chainChanged", handleChainChanged);
    provider.on("disconnect", handleDisconnect);
    return () => {
      provider.removeListener("accountsChanged", handleAccountsChanged);
      provider.removeListener("chainChanged", handleChainChanged);
      provider.removeListener("disconnect", handleDisconnect);
    };
  }, [provider]);

  // ── Auto-switch chain when wrong ───────────────────────────────────
  useEffect(() => {
    if (!wrongChain || !account || !provider) return;
    let cancelled = false;
    setIsConnecting(true);
    switchChain(provider, expectedChainId)
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to switch chain");
      })
      .finally(() => {
        if (!cancelled) setIsConnecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wrongChain, account, provider, expectedChainId]);

  // ── Connect ────────────────────────────────────────────────────────
  const connectTo = useCallback(
    async (wallet: EIP6963ProviderDetail) => {
      setPickerOpen(false);
      setIsConnecting(true);
      setError(null);
      try {
        await switchChain(wallet.provider, expectedChainId);
        const addr = await connectWallet(wallet.provider);
        setSelectedRdns(wallet.info.rdns);
        setAccount(addr);
        const id = await getWalletChainId(wallet.provider);
        if (id != null) setChainId(id);
        localStorage.setItem(STORAGE_KEY, wallet.info.rdns);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to connect wallet");
      } finally {
        setIsConnecting(false);
      }
    },
    [expectedChainId],
  );

  const connect = useCallback(async () => {
    if (availableWallets.length === 0) {
      setError("No EVM wallet found. Please install MetaMask.");
      return;
    }
    if (availableWallets.length === 1) {
      await connectTo(availableWallets[0]);
      return;
    }
    setError(null);
    setPickerOpen(true);
  }, [availableWallets, connectTo]);

  const switchAccount = useCallback(async () => {
    if (!provider) return;
    setError(null);
    try {
      const addr = await requestAccountSwitch(provider);
      setAccount(addr);
    } catch (err: unknown) {
      // User rejected or wallet doesn't support it — ignore
      if (err instanceof Error && !err.message.includes("rejected")) {
        setError(err.message);
      }
    }
  }, [provider]);

  const disconnect = useCallback(async () => {
    if (provider) await revokeWalletPermissions(provider);
    localStorage.removeItem(STORAGE_KEY);
    setSelectedRdns(null);
    setAccount(null);
    setChainId(null);
    setError(null);
  }, [provider]);

  return (
    <WalletContext.Provider
      value={{
        account,
        chainId,
        isConnecting,
        wrongChain,
        error,
        availableWallets,
        activeWallet,
        provider,
        connect,
        switchAccount,
        disconnect,
      }}
    >
      {children}
      <WalletPickerDialog
        open={pickerOpen}
        wallets={availableWallets}
        onSelect={(wallet) => void connectTo(wallet)}
        onClose={() => setPickerOpen(false)}
      />
    </WalletContext.Provider>
  );
}
