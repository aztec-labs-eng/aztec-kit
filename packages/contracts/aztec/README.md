# @aztec-kit/contracts-aztec

Noir contracts for the aztec-kit ecosystem + generated TypeScript artifacts + a handful of TS helpers.

## Contracts

| Contract                        | Purpose                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Token`                         | Standard Aztec token with private + public balances. Used for GoCoin (GO), GoCoinPremium (GOP), GoLiquidity (GOLP).                    |
| `AMM`                           | Uniswap-v2-style constant-product AMM over two Token contracts. Mints GoLiquidity shares.                                              |
| `ProofOfPassword`               | Faucet gated by a password hash. `check_password_and_mint` mints GO to the caller if the password hashes to the stored value.          |
| `SubscriptionFPC`               | Fee Payment Contract. Admin pre-registers `(contract, function)` tuples with a `maxFee`; users "subscribe" and the FPC pays their gas. |
| `SchnorrInitializerlessAccount` | Schnorr account with no `initialize` entrypoint. Signing key comes from a capsule on every call.                                       |
| `EcdsaAccountDeployer`          | ECDSA-signer variant.                                                                                                                  |

## TS exports

```ts
import { SubscriptionFPC } from "@aztec-kit/contracts-aztec/subscription-fpc";
import { FPC_GAS_CONSTANTS } from "@aztec-kit/contracts-aztec/fpc-gas-constants";
import { TokenContract, TokenContractArtifact } from "@aztec/noir-contracts.js/Token";
// … any artifact under noir/artifacts/* is reachable via /artifacts/<Name>
```

## Build

```bash
yarn workspace @aztec-kit/contracts-aztec build     # compile noir + codegen TS + tsc
yarn workspace @aztec-kit/contracts-aztec test      # vitest — integration tests using the in-process local-network fixture
```

The `build` step runs `aztec compile` inside `noir/` and then `aztec codegen` into `noir/artifacts/`. Regenerated TS artifacts are gitignored; CI rebuilds them on demand.

## Layout

```
noir/               # .nr sources + Nargo.toml workspace
noir/artifacts/     # generated TS — gitignored
lib/                # hand-written TS helpers (SubscriptionFPC wrapper, gas constants)
tests/              # vitest integration tests
```
