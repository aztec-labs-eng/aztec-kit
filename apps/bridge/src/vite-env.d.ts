/// <reference types="vite/client" />

// NOTE: deliberately no ambient `Window.ethereum` declaration. Wallets are
// discovered via EIP-6963 (see services/l1/discovery.ts, the only module
// allowed to touch `window.ethereum` as a legacy fallback); everything else
// receives an explicit EIP1193Provider.

interface ImportMetaEnv {
  readonly VITE_CUSTOM_AZTEC_NODE_URL?: string;
  readonly VITE_CUSTOM_L1_RPC_URL?: string;
  readonly VITE_CUSTOM_L1_CHAIN_ID?: string;
}

/** The app's `@aztec/aztec.js` version, injected at build time by `aztecVitePlugin`. */
declare const __AZTEC_VERSION__: string;
