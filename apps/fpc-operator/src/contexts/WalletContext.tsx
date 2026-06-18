import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { type AztecNode } from "@aztec/aztec.js/node";
import { createNode } from "@aztec-kit/common/node";
import { EmbeddedWallet, txProgress } from "@aztec-kit/embedded-wallet";
import { useNetwork } from "./NetworkContext";

type WalletStatus = "disconnected" | "loading" | "ready" | "error";

interface WalletContextType {
  status: WalletStatus;
  wallet: EmbeddedWallet | null;
  address: AztecAddress | null;
  node: AztecNode | null;
  rollupAddress: string | null;
  l1ChainId: number | null;
  l1RpcUrl: string | null;
  error: string | null;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const { activeNetwork } = useNetwork();
  const [status, setStatus] = useState<WalletStatus>("disconnected");
  const [wallet, setWallet] = useState<EmbeddedWallet | null>(null);
  const [address, setAddress] = useState<AztecAddress | null>(null);
  const [node, setNode] = useState<AztecNode | null>(null);
  const [rollupAddress, setRollupAddress] = useState<string | null>(null);
  const [l1ChainId, setL1ChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previousNodeUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (previousNodeUrlRef.current === activeNetwork.aztecNodeUrl) return;
    previousNodeUrlRef.current = activeNetwork.aztecNodeUrl;

    setStatus("loading");
    setError(null);

    (async () => {
      try {
        const nodeClient = createNode(activeNetwork.aztecNodeUrl, activeNetwork.apiKey);
        // `VITE_DISABLE_PROVER=1` turns off bb.js proving — only used in CI e2e
        // where proving starves the Aztec node's event loop on the 4 vCPU runner.
        const proverEnabled = import.meta.env.VITE_DISABLE_PROVER !== "1";
        // `VITE_WALLET_STORE=indexeddb` runs on the soon-to-be-deprecated
        // IndexedDB kv-store backend so CI keeps getting signal on it.
        const storeBackend =
          import.meta.env.VITE_WALLET_STORE === "indexeddb" ? "indexeddb" : "sqlite-opfs";
        const w = await EmbeddedWallet.create(nodeClient, {
          inspect: import.meta.env.DEV,
          pxe: { proverEnabled },
          storeBackend,
        });

        let accountManager = await w.loadStoredAccount();
        if (!accountManager) {
          accountManager = await w.createInitializerlessAccount();
        }

        const nodeInfo = await nodeClient.getNodeInfo();
        const addr = accountManager.address;
        txProgress.setAccount(addr.toString());

        setWallet(w);
        setAddress(addr);
        setNode(nodeClient);
        setRollupAddress(nodeInfo.l1ContractAddresses.rollupAddress.toString());
        setL1ChainId(nodeInfo.l1ChainId);
        setStatus("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to initialize wallet");
        setStatus("error");
      }
    })();
  }, [activeNetwork.aztecNodeUrl]);

  return (
    <WalletContext.Provider
      value={{
        status,
        wallet,
        address,
        node,
        rollupAddress,
        l1ChainId,
        l1RpcUrl: activeNetwork.l1RpcUrl,
        error,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
