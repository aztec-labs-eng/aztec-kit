/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
  /** Key for the rpc2 gateway; substituted into config/networks/testnet.json. */
  readonly VITE_TESTNET_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The app's `@aztec/aztec.js` version, injected at build time by `aztecVitePlugin`. */
declare const __AZTEC_VERSION__: string;
