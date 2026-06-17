import { resolve } from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { aztecVitePlugin } from "@aztec-kit/common/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
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
        "@aztec-kit/contracts-ethereum": resolve(
          import.meta.dirname,
          "../../packages/contracts/ethereum/lib/deterministic.ts",
        ),
      },
    },
    // Pin the port + fail rather than auto-bump. OPFS storage is keyed by
    // origin (scheme+host+port); a drifting port means the wallet writes a
    // sqlite OPFS file under :5173 one session and tries to read it under
    // :5174 the next, ending up with stale or unreadable stores. `strictPort`
    // makes Vite refuse to start on a taken port instead of silently picking
    // another one.
    server: { port: 5173, strictPort: true },
    plugins: [aztecVitePlugin(), react({ jsxImportSource: "@emotion/react" })],
    define: {
      "process.env": JSON.stringify({
        LOG_LEVEL: env.LOG_LEVEL,
      }),
    },
  };
});
