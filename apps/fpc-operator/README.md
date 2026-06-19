# @aztec-kit/fpc-operator

Operator dashboard for deploying and running a [SubscriptionFPC](../../packages/contracts/aztec/noir/src/subscription_fpc) — the fee-payment contract that sponsors user transactions on the swap app.

## Dev

```bash
yarn workspace @aztec-kit/fpc-operator dev
```

Requires an Aztec node (local network or a remote RPC).

## UI

- **SetupWizard** — first-time flow: initialize wallet → deploy admin + deploy FPC (embedded bridge iframe handles FJ funding for the FPC) → land on dashboard.
- **Dashboard** — view the FPC's funded balance, registered sign_ups, per-function calibration.
- **AppSignUp** — add new sponsored functions to the FPC with P75-calibrated `maxFee`.
- **Backup/Restore** — export/import the admin secret + FPC keys as JSON.

## Scripts

All run with `yarn workspace @aztec-kit/fpc-operator <name>`. Each accepts `--network local|testnet|nextnet`.

| Script                 | Purpose                                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-fpc:<network>` | Deploy the SubscriptionFPC and bridge FJ to it so it can sponsor gas, via the declarative deploy framework. The FPC admin is an initializerless account (no separate admin-deploy step). Writes a gitignored backup JSON to `backups/<network>.fpc-admin.json`. |

Run via `yarn setup:local` / `yarn setup:testnet` / `yarn setup:nextnet` at the repo root (orchestrates admins + contracts + FPC + sign_ups).

## Env vars

| Var                | Used by                | Meaning                                                                                   |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------------------- |
| `FPC_ADMIN_SECRET` | both scripts           | Deterministic admin key. Generated + printed if unset.                                    |
| `FPC_SECRET`       | `deploy-fpc`           | FPC contract key secret (used so the PXE can decode FPC-owned notes). Generated if unset. |
| `SALT`             | both                   | Contract address salt. Default `Fr(0)`.                                                   |
| `L1_FUNDER_KEY`    | `deploy-fpc` (testnet) | Optional L1 private key holding FJ. Unset → faucet mints.                                 |
