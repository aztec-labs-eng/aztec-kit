# @aztec-kit/e2e

Playwright suite driving all three apps through a realistic user flow against a real local Aztec network.

## Pipeline

```
fpc-setup → bridge-fund → swap-deploy → fpc-signup → swap-flow
```

Each project depends on the previous via Playwright's `dependencies` mechanism. State is checkpointed to `.state/<name>.json`. Checkpoints are reused only with `E2E_SKIP_NETWORK=1`, when you are intentionally pointing at the same already-running local network.

| Spec                        | App          | What it does                                                                                                                 |
| --------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `01-fpc-setup`              | fpc-operator | Drives the SetupWizard — bridges FJ (via embedded bridge iframe), deploys the FPC.                                           |
| `02-bridge-fund-swap-admin` | bridge       | Drives the bridge UI end-to-end to fund swap-admin with real bridged FJ. Verifies the bridge path works.                     |
| `03-swap-deploy`            | node script  | Runs `apps/swap/scripts/deploy.ts --payment feejuice` — deploys swap contracts, paying from swap-admin's freshly-bridged FJ. |
| `04-fpc-signup`             | fpc-operator | Mints swap tokens to FPC admin, calibrates + signs up sponsored functions.                                                   |
| `05-swap-flow`              | swap         | Full user onboarding + swap + drip + send via the swap UI.                                                                   |

## Running

```bash
# From repo root
yarn build                                # packages must be built for artifact imports
yarn workspace @aztec-kit/e2e test       # full suite — spins up local-network in globalSetup
```

Environment toggles:

| Env                  | Effect                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `E2E_HEADED=1`       | Run headed browsers.                                                                                         |
| `E2E_SLOW_MO=500`    | Slow each action by N ms (implies headed).                                                                   |
| `E2E_SKIP_NETWORK=1` | Don't spawn `aztec start --local-network` — assumes one is already running; preserves `.state/` checkpoints. |
| `E2E_RESET=1`        | Wipe `.state/` before the run; equivalent to `yarn e2e:reset`.                                               |

## Global setup/teardown

`fixtures/global-setup.ts` spawns `aztec start --local-network`, deploys the L1 bridge contract (CREATE2, idempotent), derives the swap-admin identity, and writes `.state/global.json`. `global-teardown.ts` kills the local-network process.

## CI

`.github/workflows/ci.yml`'s `e2e` job runs inside Playwright's official container image (`mcr.microsoft.com/playwright:v1.59.1-noble`) which ships chromium + all apt system deps preinstalled. On failure, the Playwright HTML report uploads as an artifact.
