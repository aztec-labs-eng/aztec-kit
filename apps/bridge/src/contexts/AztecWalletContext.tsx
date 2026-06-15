import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { EmbeddedWallet } from "@aztec-kit/embedded-wallet";
import { useNetwork } from "./NetworkContext";
import {
  getAztecNode,
  type ClaimCredentials,
  claimWithBootstrap as claimWithBootstrapSvc,
  claimBatch as claimBatchSvc,
} from "../services";

export type AztecWalletStatus =
  | "disconnected"
  | "loading"
  | "creating"
  | "connecting" // connecting external wallet
  | "ready" // account registered with PXE, usable immediately
  | "claiming" // claiming fee juice
  | "funded" // account has fee juice
  | "error";

interface AztecWalletContextType {
  status: AztecWalletStatus;
  /** The currently active wallet (external if connected, otherwise embedded) */
  activeWallet: Wallet | null;
  wallet: EmbeddedWallet | null;
  externalWallet: Wallet | null;
  address: AztecAddress | null;
  feeJuiceBalance: string | null;
  error: string | null;
  isExternal: boolean;
  connectAztecWallet: () => Promise<void>;
  connectExternalWallet: (wallet: Wallet, walletAddress: AztecAddress) => Promise<void>;
  claimWithBootstrap: (
    bootstrapClaim: ClaimCredentials,
    otherClaims: ClaimCredentials[],
  ) => Promise<void>;
  claimBatch: (claims: ClaimCredentials[]) => Promise<void>;
  resetAccount: () => Promise<void>;
  disconnect: () => void;
  refreshFeeJuiceBalance: () => Promise<void>;
}

const AztecWalletContext = createContext<AztecWalletContextType | undefined>(undefined);

export function useAztecWallet() {
  const context = useContext(AztecWalletContext);
  if (!context) throw new Error("useAztecWallet must be used within an AztecWalletProvider");
  return context;
}

export function AztecWalletProvider({ children }: { children: ReactNode }) {
  const { activeNetwork } = useNetwork();
  const [status, setStatus] = useState<AztecWalletStatus>("disconnected");
  const [wallet, setWallet] = useState<EmbeddedWallet | null>(null);
  const [externalWallet, setExternalWallet] = useState<Wallet | null>(null);
  const [address, setAddress] = useState<AztecAddress | null>(null);
  const [feeJuiceBalance, setFeeJuiceBalance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isExternal = externalWallet !== null;
  const activeWallet: Wallet | null = externalWallet ?? wallet;

  // Guard against concurrent connectAztecWallet calls (StrictMode, re-renders)
  const connectingRef = useRef<Promise<void> | null>(null);

  const initEmbeddedWallet = useCallback(async (): Promise<EmbeddedWallet> => {
    const node = getAztecNode(activeNetwork.aztecNodeUrl, activeNetwork.apiKey);
    // `VITE_DISABLE_PROVER=1` turns off bb.js proving — only used in CI e2e
    // where proving starves the Aztec node's event loop on the 4 vCPU runner.
    const proverEnabled = import.meta.env.VITE_DISABLE_PROVER !== "1";
    return EmbeddedWallet.create(node, {
      inspect: import.meta.env.DEV,
      pxe: { proverEnabled },
    });
  }, [activeNetwork]);

  const refreshFeeJuiceBalance = useCallback(async () => {
    if (!activeWallet || !address) return;
    try {
      const fj = FeeJuiceContract.at(activeWallet);
      const { result } = await fj.methods.balance_of_public(address).simulate({ from: address });
      const bal = result.toString();
      setFeeJuiceBalance(bal);
      if (BigInt(bal) > 0n) {
        setStatus((prev) => (prev === "ready" ? "funded" : prev));
      }
    } catch (e) {
      console.warn("[aztec-wallet] Failed to refresh fee juice balance:", e);
      setFeeJuiceBalance(null);
    }
  }, [activeWallet, address]);

  useEffect(() => {
    if (activeWallet && address && (status === "funded" || status === "ready")) {
      refreshFeeJuiceBalance();
    }
  }, [activeWallet, address, status, refreshFeeJuiceBalance]);

  // Create or load embedded wallet with initializerless account
  const connectAztecWallet = useCallback(async () => {
    // Deduplicate: if already connecting, return the in-flight promise
    if (connectingRef.current) return connectingRef.current;

    const doConnect = async () => {
      setStatus("creating");
      setError(null);
      try {
        const w = await initEmbeddedWallet();

        // Try loading existing stored account, or create a new one
        let accountManager = await w.loadStoredAccount();
        if (!accountManager) {
          accountManager = await w.createInitializerlessAccount();
        }

        setWallet(w);
        setAddress(accountManager.address);
        setStatus("ready");
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to create Aztec wallet");
        setStatus("error");
      } finally {
        connectingRef.current = null;
      }
    };

    connectingRef.current = doConnect();
    return connectingRef.current;
  }, [initEmbeddedWallet]);

  // Connect external wallet (from wallet SDK discovery)
  const connectExternalWallet = useCallback(async (w: Wallet, walletAddress: AztecAddress) => {
    setExternalWallet(w);
    setAddress(walletAddress);

    setStatus("funded"); // external wallets are assumed funded
    setError(null);
  }, []);

  const withClaimStatus = useCallback(
    async (claimFn: () => Promise<unknown>) => {
      if (!activeWallet || !address) throw new Error("No wallet connected");
      setStatus("claiming");
      setError(null);
      try {
        await claimFn();
        setStatus("funded");
        refreshFeeJuiceBalance();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Claim failed");
        setStatus("error");
      }
    },
    [activeWallet, address, refreshFeeJuiceBalance],
  );

  const claimWithBootstrap = useCallback(
    (bootstrapClaim: ClaimCredentials, otherClaims: ClaimCredentials[]) =>
      withClaimStatus(() =>
        claimWithBootstrapSvc(activeWallet!, address!, bootstrapClaim, otherClaims),
      ),
    [activeWallet, address, withClaimStatus],
  );

  const claimBatch = useCallback(
    (claims: ClaimCredentials[]) =>
      withClaimStatus(() => claimBatchSvc(activeWallet!, address!, claims)),
    [activeWallet, address, withClaimStatus],
  );

  const clearWalletState = useCallback(() => {
    setWallet(null);
    setExternalWallet(null);
    setAddress(null);
    setFeeJuiceBalance(null);
    setStatus("disconnected");
    setError(null);
  }, []);

  const resetAccount = useCallback(async () => {
    if (wallet) {
      try {
        await wallet.deleteStoredAccount();
      } catch {
        /* ignore */
      }
    }
    clearWalletState();
  }, [wallet, clearWalletState]);

  const disconnect = clearWalletState;

  return (
    <AztecWalletContext.Provider
      value={{
        status,
        activeWallet,
        wallet,
        externalWallet,
        address,
        feeJuiceBalance,
        error,
        isExternal,
        connectAztecWallet,
        connectExternalWallet,
        claimWithBootstrap,
        claimBatch,
        resetAccount,
        disconnect,
        refreshFeeJuiceBalance,
      }}
    >
      {children}
    </AztecWalletContext.Provider>
  );
}
