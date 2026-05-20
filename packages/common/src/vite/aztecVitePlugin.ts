import { createRequire } from "module";
import type { Plugin, UserConfig } from "vite";
import { nodePolyfillsFix } from "./nodePolyfillsFix.ts";
import { wasmContentTypePlugin } from "./wasmContentTypePlugin.ts";

export type AztecVitePluginOptions = {
  /**
   * Lower source / build target to `es2016` when true. Needed in dev if any
   * downstream profiling tool (e.g. zone.js) hooks `Promise.prototype.then` —
   * V8's fast-await bypass makes native async functions invisible to those
   * hooks. Leave false/default in production for speed.
   */
  es2016?: boolean;
};

/**
 * Reads Vite's installed major version by resolving `vite/package.json` from
 * the consumer's perspective. Returns `NaN` if resolution fails — we default
 * to modern Vite behavior in that case.
 */
function detectViteMajor(): number {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("vite/package.json") as { version: string };
    const major = Number(pkg.version.split(".")[0]);
    return Number.isFinite(major) ? major : NaN;
  } catch {
    return NaN;
  }
}

/**
 * Drop-in Vite plugin for all aztec-kit apps. Sets the headers, pre-bundle
 * config, and polyfill plumbing that every app needs, adapting to the
 * installed Vite major version.
 *
 * On Vite 8+:
 *   - Cross-origin isolation headers (COOP/COEP/CORP) for SharedArrayBuffer
 *   - `oxc` + `build` targets (optionally es2016 for zone.js async/await)
 *   - Node polyfills (`buffer`, `path`) with absolute-path workaround for
 *     yarn-workspace hoisting
 *
 * On Vite 7 (and older) — additionally:
 *   - `optimizeDeps.exclude: ['@aztec/kv-store/sqlite-opfs', '@sqlite.org/sqlite-wasm',
 *     '@aztec/noir-acvm_js', '@aztec/noir-noirc_abi', '@aztec/bb.js']` so Web Worker
 *     spawns via `new Worker(new URL('./worker.js', import.meta.url))` and sibling
 *     `.wasm` assets resolve against their real `node_modules` locations.
 *   - `optimizeDeps.include` for the CJS transitive deps reached via excluded
 *     sqlite-opfs (`pino`, `sha3`, `util`, `lodash.*`) — they need Vite's CJS→ESM
 *     interop or their named imports break.
 *   - `wasmContentTypePlugin` — forces `application/wasm` MIME on `.wasm`
 *     responses so `WebAssembly.compileStreaming` accepts them.
 *
 * Returns `Plugin[]` rather than a single Plugin so Vite flattens the composite.
 */
export function aztecVitePlugin(options: AztecVitePluginOptions = {}): Plugin[] {
  const target = options.es2016 ? "es2016" : "esnext";
  const viteMajor = detectViteMajor();
  const isLegacyVite = Number.isFinite(viteMajor) && viteMajor < 8;

  const configPlugin: Plugin = {
    name: "aztec-vite-config",
    config(): UserConfig {
      // Cross-cutting defaults that apply on all Vite versions.
      const base = {
        server: {
          headers: {
            // SharedArrayBuffer requires cross-origin isolation (bb.js threads).
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            // Allows this app to be embedded by the wallet iframe / dApp host.
            "Cross-Origin-Resource-Policy": "cross-origin",
          },
        },
        build: { target },
      };

      if (isLegacyVite) {
        // Vite ≤7: esbuild-based pre-bundler leaves `new Worker(new URL(...))`
        // verbatim in bundled output, and doesn't copy adjacent .wasm assets.
        // Exclude packages what use wasm, workers or both from pre-bundle and
        // force the CJS transitives back in so their named imports still interop.
        // The `esbuild.target` shape here matches Vite 7's `UserConfig`; on
        // Vite 8 the field was narrowed and the legacy `target` is gone, so
        // we cast through `UserConfig` to satisfy whichever vite type the
        // workspace happens to resolve at compile time.
        return {
          ...base,
          esbuild: { target },
          optimizeDeps: {
            exclude: [
              "@aztec/noir-acvm_js",
              "@aztec/noir-noirc_abi",
              "@aztec/bb.js",
              "@aztec/sqlite3mc-wasm",
              "@aztec/kv-store/sqlite-opfs",
            ],
            include: [
              "pino",
              "pino/browser",
              "sha3",
              "util",
              "lodash.chunk",
              "lodash.clonedeepwith",
            ],
          },
        } as UserConfig;
      }

      // Vite 8+: Rolldown pre-bundler handles worker/wasm assets correctly —
      // no excludes or CJS includes needed. `oxc.target` covers user source;
      // `optimizeDeps.rolldownOptions.transform.target` is needed in addition
      // to downlevel pre-bundled deps in `node_modules/.vite/deps/*` (without
      // it, the deps ship native async/await even when es2016 is requested,
      // which defeats zone.js because V8/SpiderMonkey's fast-await bypasses
      // user-space Promise.prototype.then). Fixed in Vite 8.0.10 (#22273).
      return {
        ...base,
        oxc: { target },
        optimizeDeps: {
          rolldownOptions: { transform: { target } },
        },
      };
    },
  };

  const plugins: Plugin[] = [
    configPlugin,
    nodePolyfillsFix({ include: ["buffer", "path", "tty"] }),
  ];

  if (isLegacyVite) {
    plugins.push(wasmContentTypePlugin());
  }

  return plugins;
}
