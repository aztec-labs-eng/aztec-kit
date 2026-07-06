import { readFileSync } from "fs";
import { createRequire } from "module";
import type { Plugin } from "vite";

/**
 * Emits `@aztec/sqlite3mc-wasm`'s runtime-loaded files into `assets/` under
 * their ORIGINAL names, so production builds can serve them.
 *
 * Since the SQLite3MultipleCiphers 2.3.5 bump (aztec-packages#24293), the
 * sqlite3mc loader always resolves its wasm through its `Module['locateFile']`
 * hook, which computes `new URL(path, import.meta.url)` with a *dynamic*
 * `path` — invisible to the bundler. At runtime the worker chunk therefore
 * requests `assets/sqlite3.wasm` (unhashed) relative to itself and 404s in
 * production ("unsupported MIME type" as the follow-up error, from the 404
 * page). The bundler only rewrites the *static* fallback reference, emitting
 * a hashed copy that nothing loads. Dev servers are unaffected (they serve
 * straight from node_modules), which is why e2e never caught it.
 *
 * The OPFS async-proxy worker script is resolved the same runtime-relative
 * way (`scriptInfo.sqlite3Dir + 'sqlite3-opfs-async-proxy.js'`), so both
 * files are emitted. Fails soft when the package isn't installed.
 */
export function sqliteRuntimeAssetsPlugin(): Plugin {
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
