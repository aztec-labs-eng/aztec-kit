# @aztec-kit/common

Shared building blocks used by every app + every script in the monorepo. Organised by domain — no cross-domain barrel.

## Subpath exports

| Import                      | Contents                                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@aztec-kit/common/ui`      | `shortAddress`, `NetworkSwitcher`, `createNetworkContext`. React + MUI. Used by all three app UIs.                                                                       |
| `@aztec-kit/common/fees`    | `fetchFeeStats`, `computeMaxFeeFromP75` — calibrate `maxFee` from the clustec public fee API.                                                                            |
| `@aztec-kit/common/testing` | Deploy-script plumbing: network config, CLI arg parsing, wallet setup, admin account helpers, in-process + CLI local-network fixtures, tracked-spawn helpers. Node-only. |
| `@aztec-kit/common/vite`    | `aztecVitePlugin` (drop-in, Vite-version-aware) + `chunkSizeValidator`. See `vite` section below.                                                                        |

## `testing` — highlights

```ts
import {
  parseNetwork, // reads --network from argv
  setupWallet, // EmbeddedWallet + SponsoredFPC registered
  loadOrCreateSecret, // env-var-backed Fr secret
  getAdmin, // derive the admin's initializerless account address (no deploy tx)
  setupLocalNetwork, // in-process: anvil + AztecNodeService in this process
  setupLocalNetworkCli, // out-of-process: `aztec start --local-network`
  spawnTracked, // detached spawn + cleanup-on-exit registry
  ensureAztecBinsInPath, // splice `~/.aztec/current/internal-bin` onto PATH
} from "@aztec-kit/common/testing";
```

Two launch modes share the same spawn/cleanup machinery (`./spawn.ts`):

- **`setupLocalNetwork({ fundedAddresses })`** — in-process. Spawns a fresh anvil on a random port, deploys L1, starts an `AztecNodeService`, pre-funds at genesis. Each caller gets its own local network, so vitest suites run in parallel. Used by `packages/contracts/aztec/tests/*` and `packages/embedded-wallet/tests/*`.

- **`setupLocalNetworkCli({ logDir })`** — out-of-process. Shells out to `aztec start --local-network` (anvil + node + sequencer + prover as one subprocess tree on ports 8545/8080) and waits for both JSON-RPCs to answer. Slower but exercises the same CLI real users hit; used by the playwright e2e harness.

Both place every child in its own POSIX process group and register `SIGINT`/`SIGTERM`/`SIGHUP`/`exit` handlers, so killing the test runner — gracefully or not — tears down anvil and friends with it. Required since the aztec-up change that stopped exposing `anvil`/`forge`/`nargo` on the user's PATH: `ensureAztecBinsInPath()` splices `~/.aztec/current/internal-bin` in so `@aztec/ethereum`'s internal `spawn("forge", ...)` keeps working.

## `vite`

```ts
import { aztecVitePlugin } from "@aztec-kit/common/vite";

export default defineConfig({
  plugins: [aztecVitePlugin() /* react(), etc. */],
});
```

Sets cross-origin isolation headers, node polyfills (`buffer`, `path`) with the yarn-workspace absolute-path fix, and the build/source targets. On Vite ≤7 it also adds the `optimizeDeps.exclude` list (bb.js, noir wasm packages, sqlite-wasm, kv-store sqlite-opfs), the matching CJS `include` list (pino, util, sha3, lodash.\*), and a `.wasm` content-type middleware — all needed because Vite 7's esbuild pre-bundler mis-handles Web Workers and sibling `.wasm` assets. Vite 8's Rolldown pre-bundler handles those correctly, so none of the extras are applied there.

`{ es2016: true }` lowers `build.target` / `oxc.target` (or `esbuild.target` on Vite ≤7) so native `async function`s get transpiled to Promise chains. Set this in dev if you use zone.js — V8's "fast await" otherwise bypasses `Promise.prototype.then` hooks.
