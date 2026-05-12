import type { Plugin } from "vite";

/**
 * Forces `Content-Type: application/wasm` on `.wasm` responses served by Vite's
 * dev server. Without this, `WebAssembly.compileStreaming()` — used by Aztec's
 * sqlite3mc-wasm (and noir-acvm_js / bb.js / etc.) Emscripten init — rejects
 * with "Incorrect response MIME type". Vite's middleware doesn't set this
 * header for files served from aliased / @fs paths outside node_modules.
 */
export function wasmContentTypePlugin(): Plugin {
  return {
    name: "wasm-content-type",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith(".wasm") || req.url?.includes(".wasm?")) {
          res.setHeader("Content-Type", "application/wasm");
        }
        next();
      });
    },
  };
}
