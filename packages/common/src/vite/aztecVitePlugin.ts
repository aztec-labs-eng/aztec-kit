import { readFileSync } from "fs";
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
 * Reads the app's `@aztec/aztec.js` pin from its own package.json (Vite runs
 * with cwd = the app dir). Pins are exact in this repo, so the pin IS the
 * installed version; the installed package.json itself is not reachable
 * (`@aztec/aztec.js` doesn't export `./package.json`). Returns "unknown" if
 * the pin can't be read.
 */
function detectAztecVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(`${process.cwd()}/package.json`) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return (
      pkg.dependencies?.["@aztec/aztec.js"] ?? pkg.devDependencies?.["@aztec/aztec.js"] ?? "unknown"
    );
  } catch {
    return "unknown";
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
        // Every app gets the @aztec/* version it was built against as a
        // compile-time constant (shown in the footers). Declared for TS in
        // each app's src/vite-env.d.ts.
        define: {
          __AZTEC_VERSION__: JSON.stringify(detectAztecVersion()),
        },
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
    sqliteRuntimeAssetsPlugin(),
    nodePolyfillsFix({ include: ["buffer", "path", "tty"] }),
  ];

  if (isLegacyVite) {
    plugins.push(wasmContentTypePlugin());
  }

  return plugins;
}

/**
 * Emits `@aztec/sqlite3mc-wasm`'s runtime-loaded files into `assets/` under
 * their ORIGINAL names.
 *
 * The sqlite3mc loader always goes through its `Module['locateFile']` hook,
 * which computes `new URL(path, import.meta.url)` with a *dynamic* `path` —
 * invisible to the bundler, so at runtime the worker chunk requests
 * `assets/sqlite3.wasm` (unhashed) relative to itself. The bundler only
 * rewrites the *static* dead-code fallback, emitting a hashed copy nothing
 * references. Result: 404 + "unsupported MIME type" in production builds
 * (dev is unaffected — the dev server serves straight from node_modules).
 * The OPFS async-proxy worker script is resolved the same way
 * (`scriptInfo.sqlite3Dir + 'sqlite3-opfs-async-proxy.js'`), so both files
 * are emitted. Fails soft when the package isn't installed.
 */
function sqliteRuntimeAssetsPlugin(): Plugin {
  const RUNTIME_FILES = ["sqlite3.wasm", "sqlite3-opfs-async-proxy.js"];
  return {
    name: "aztec-sqlite-runtime-assets",
    apply: "build",
    generateBundle() {
      const require = createRequire(`${process.cwd()}/package.json`);
      for (const file of RUNTIME_FILES) {
        let resolved: string;
        try {
          resolved = require.resolve(`@aztec/sqlite3mc-wasm/vendor/jswasm/${file}`);
        } catch {
          return; // package not installed (e.g. a line that predates sqlite-opfs)
        }
        this.emitFile({
          type: "asset",
          fileName: `assets/${file}`,
          source: readFileSync(resolved),
        });
      }
    },
  };
}
