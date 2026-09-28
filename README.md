# aztec-kit

Three Aztec apps and the libraries that glue them together, in one yarn-workspace monorepo.

## Apps

| App                                   | What it does                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| [**swap**](apps/swap)                 | Private token AMM (GO ↔ GOP) with a proof-of-password faucet. End-user app.         |
| [**bridge**](apps/bridge)             | Wizard for bridging fee juice from L1 → L2 so an Aztec address can pay its own gas. |
| [**fpc-operator**](apps/fpc-operator) | Operator dashboard for deploying + administering a SubscriptionFPC.                 |

## Packages

| Package                                                        | What it does                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@aztec-kit/common`](packages/common)                         | Shared building blocks: bridging helpers, fee-stats helpers, UI widgets, deploy-script plumbing, and the in-process `setupLocalNetwork` test fixture. |
| [`@aztec-kit/embedded-wallet`](packages/embedded-wallet)       | Embeddable Aztec wallet with initializerless schnorr account + React bindings.                                                                        |
| [`@aztec-kit/contracts-aztec`](packages/contracts/aztec)       | Noir contracts (AMM, Token, ProofOfPassword, SubscriptionFPC, …) + TypeScript artifacts.                                                              |
| [`@aztec-kit/contracts-ethereum`](packages/contracts/ethereum) | L1 bridge Solidity contract + deterministic CREATE2 deploy.                                                                                           |
| [`@aztec-kit/e2e`](e2e)                                        | Playwright suite driving all three apps through a full onboarding flow.                                                                               |

## Prerequisites

- Node.js 22+ via `nvm`
- Yarn 4.5.2 (enabled via Corepack — `corepack enable`)
- Aztec CLI: `curl -fsSL https://install.aztec-labs.com/<version>/install | bash` (version pinned in `apps/bridge/package.json`'s `@aztec-labs/aztec.js`)
- Foundry (for L1 anvil + forge)

## Quickstart (local dev)

```bash
yarn install
yarn build                                                  # compiles noir contracts + TS packages
aztec start --local-network                                 # in a separate terminal
SWAP_ADMIN_SECRET=0x… FPC_ADMIN_SECRET=0x… yarn setup:local # deploys admins + contracts + FPC
yarn dev                                                    # starts all three app dev servers
```

`yarn setup:local` orchestrates the whole chain: deploy swap admin → deploy swap contracts → deploy FPC admin → deploy FPC (with L1→L2 FJ bridge) → register sponsored functions on the FPC. Secrets/addresses are echoed back as `export …=…` lines and captured between steps by [`scripts/setup-network.sh`](scripts/setup-network.sh). Re-running is idempotent.

Omit `SWAP_ADMIN_SECRET` / `FPC_ADMIN_SECRET` to generate fresh ones; the exported values are printed so you can re-use them on the next run.

## Common commands

```bash
yarn build           # turbo — builds all packages + apps
yarn typecheck       # turbo — tsc across everything
yarn test            # turbo — integration tests (@aztec-kit/contracts-aztec + @aztec-kit/embedded-wallet)
yarn lint            # turbo — eslint across everything
yarn format          # prettier check; `yarn format:fix` to write

yarn setup:local     # full local deploy chain (see above)
yarn setup:testnet   # same chain against testnet (needs L1_FUNDER_KEY or uses the faucet)

yarn workspace @aztec-kit/e2e test   # run the Playwright suite
```

## Updating Aztec

```bash
node scripts/update.js                                   # auto-detect latest nightly
node scripts/update.js --version 4.3.0-nightly.20260420  # pin a version
```

Bumps every workspace `package.json` and every `Nargo.toml`, runs `aztec-up`, and recompiles contracts.
