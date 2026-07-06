import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { aztecVitePlugin, chunkSizeValidator } from "@aztec-kit/common/vite";

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // Profiling (zone.js-based async context tracking) runs only in dev.
  // V8's "fast await" optimization bypasses user-space Promise.prototype.then
  // for native `async function` bodies, breaking zone.js propagation. Lowering
  // the source/build target to es2016 in dev forces async/await to be transpiled
  // to Promise-based state machines that DO go through user-level .then() —
  // which zone.js can hook. Prod keeps esnext for speed.
  const isDev = command === "serve";

  return {
    base: "./",
    logLevel: process.env.CI ? "error" : undefined,
    resolve: {
      alias: {
        "@aztec-kit/embedded-wallet/ui": resolve(
          import.meta.dirname,
          "../../packages/embedded-wallet/src/ui.ts",
        ),
        "@aztec-kit/embedded-wallet": resolve(
          import.meta.dirname,
          "../../packages/embedded-wallet/src/index.ts",
        ),
        "@aztec-kit/common/ui": resolve(
          import.meta.dirname,
          "../../packages/common/src/ui/index.ts",
        ),
        "@aztec-kit/common/bridging": resolve(
          import.meta.dirname,
          "../../packages/common/src/bridging/index.ts",
        ),
        "@aztec-kit/common/fees": resolve(
          import.meta.dirname,
          "../../packages/common/src/fees/index.ts",
        ),
        "@aztec-kit/common/testing": resolve(
          import.meta.dirname,
          "../../packages/common/src/testing/index.ts",
        ),
        "@aztec-kit/contracts-aztec/subscription-fpc": resolve(
          import.meta.dirname,
          "../../packages/contracts/aztec/lib/subscription-fpc.ts",
        ),
        "@aztec-kit/contracts-aztec/fpc-gas-constants": resolve(
          import.meta.dirname,
          "../../packages/contracts/aztec/lib/fpc-gas-constants.ts",
        ),
        "@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC": resolve(
          import.meta.dirname,
          "../../packages/contracts/aztec/noir/artifacts/SubscriptionFPC.ts",
        ),
        "@aztec-kit/contracts-aztec/artifacts/AMM": resolve(
          import.meta.dirname,
          "../../packages/contracts/aztec/noir/artifacts/AMM.ts",
        ),
        "@aztec-kit/contracts-aztec/artifacts/ProofOfPassword": resolve(
          import.meta.dirname,
          "../../packages/contracts/aztec/noir/artifacts/ProofOfPassword.ts",
        ),
      },
    },
    // Pin the port + fail rather than auto-bump. OPFS storage is keyed by
    // origin (scheme+host+port); a drifting port means the wallet writes a
    // sqlite OPFS file under :5175 one session and tries to read it under
    // :5176 the next, ending up with stale or unreadable stores. `strictPort`
    // makes Vite refuse to start on a taken port instead of silently picking
    // another one.
    server: { port: 5175, strictPort: true },
    plugins: [
      aztecVitePlugin({ es2016: isDev }),
      react({ jsxImportSource: "@emotion/react" }),
      chunkSizeValidator([
        {
          pattern: /assets\/index-.*\.js$/,
          maxSizeKB: 1700,
          description: "Main entrypoint, hard limit",
        },
        {
          pattern: /.*/,
          maxSizeKB: 8000,
          description: "Detect if json artifacts or bb.js wasm get out of control",
        },
      ]),
    ],
    define: {
      "process.env": JSON.stringify({
        LOG_LEVEL: env.LOG_LEVEL,
      }),
    },
  };
});
