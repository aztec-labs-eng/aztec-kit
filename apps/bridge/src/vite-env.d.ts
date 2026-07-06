/// <reference types="vite/client" />

interface Window {
  ethereum?: {
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    on: (event: string, callback: (...args: unknown[]) => void) => void;
    removeListener: (event: string, callback: (...args: unknown[]) => void) => void;
    isMetaMask?: boolean;
  };
}

interface ImportMetaEnv {
  readonly VITE_CUSTOM_AZTEC_NODE_URL?: string;
  readonly VITE_CUSTOM_L1_RPC_URL?: string;
  readonly VITE_CUSTOM_L1_CHAIN_ID?: string;
}

/** The app's `@aztec/aztec.js` version, injected at build time by `aztecVitePlugin`. */
declare const __AZTEC_VERSION__: string;
