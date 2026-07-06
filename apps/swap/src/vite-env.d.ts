/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** The app's `@aztec/aztec.js` version, injected at build time by `aztecVitePlugin`. */
declare const __AZTEC_VERSION__: string;
