# Handoff: Bisect the `wasm-bindgen-futures` `JsFuture::finish` panic

You're picking up a bisect that's mid-flight. Goal: find the exact aztec-packages commit that broke the browser-side simulator during `SubscriptionFPC.calibrate`.

## The bug

When the fpc-operator app simulates `SubscriptionFPC.calibrate` (the wizard's "sign up app" flow), the wasm panics inside `wasm-bindgen-futures-0.4.63/src/lib.rs:164:39` (`JsFuture::finish`). The error mode shifts depending on which mitigation is in place:

| Symptom | Cause |
| --- | --- |
| `panicked at … lib.rs:164: RefCell already borrowed` | First-order observation. Executor state mid-borrow when `finish` ran. |
| `RuntimeError: memory access out of bounds at JsFuture::finish` | After `optimizeDeps.exclude` for `@aztec/noir-acvm_js` (singleton resolution). Same `finish`, now a raw wasm trap. |
| `Error: closure invoked recursively or after being dropped` | After an explicit `await Promise.resolve()` before `executePrivateFunction`. wasm-bindgen's own re-entry check fires explicitly. |

All three are the same root cause: **a wasm-bindgen `Closure` (the wasm-bindgen-futures executor's microtask handler, almost certainly) is being invoked recursively**. The chain we observed:

```
SubscriptionFPC.calibrate
  → static_call_private_function(admin, "verify_private_authwit")
    → aztec_prv_callPrivateFunction oracle handler (PXE side)
      → executePrivateFunction
        → simulator.executeUserCircuit
          → executeCircuitWithReturnWitness(inner) ← wasm-bindgen-exposed async fn,
            spawn_local's onto the SAME executor as the outer
```

The recursive-simulation pattern is foundational to the Aztec architecture and has worked for years. So this is **not** a structural problem — it's a regression in one of the changes between v5.0.0-nightly.20260521 and v5.0.0-nightly.20260527.

## Known good vs broken

| Where | aztec-packages version | Behaviour |
| --- | --- | --- |
| **`aztec-kit` `main`** | `v4.3.0-rc.1` | Works (calibrate succeeds) |
| **`aztec-kit` `next`** | `v5.0.0-nightly.20260521` | Works (deployed, verified by user) |
| **PR #17 CI (`gj/update_nightly`)** | `v5.0.0-nightly.20260527` | **Panics** in calibrate |
| **`gj/update_nightly` local + `20260528` deps** | `v5.0.0-nightly.20260528` | **Panics** in calibrate |

→ Regression landed somewhere in `v5.0.0-nightly.20260521..v5.0.0-nightly.20260527` (≈ 5 nightly tags, ≈ 25 substantive commits in `yarn-project/` + `noir-projects/`).

## Repos

- **aztec-kit**: <https://github.com/aztec-labs-eng/aztec-kit>
- **aztec-packages**: <https://github.com/AztecProtocol/aztec-packages>

Local checkouts on this Mac:

- `/Users/gregoriojulianaquiros/Repos/aztec-kit` (current working tree, branch `gj/bisect-20260522`)
- `/Users/gregoriojulianaquiros/Repos/aztec-packages` (for inspecting upstream commits/tags)

## Branches and PRs

| Branch | State | Notes |
| --- | --- | --- |
| `main` | `v4.3.0-rc.1`, working baseline | Don't touch |
| `next` | `v5.0.0-nightly.20260521`, last known good | Reference deploy |
| `gj/update_nightly` | `v5.0.0-nightly.20260528`, panics | The branch we're trying to land; PR #17 |
| `gj/bisect-20260522` | `v5.0.0-nightly.20260522`, **first bisect step** | PR #19 (this PR) |

Open PRs:

- **PR #17** <https://github.com/aztec-labs-eng/aztec-kit/pull/17> — the original `gj/update_nightly` → `next` PR. CI e2e reproduces the panic. Useful as the "broken" reference.
- **PR #19** <https://github.com/aztec-labs-eng/aztec-kit/pull/19> — the bisect PR at `20260522`. CI is currently running. If it panics → regression is in the 0521→0522 one-day window (9 commits). If it passes → bisect forward.

## ⚠️ E2E target uncertainty

When you check PR #19's e2e logs, **first verify the test is actually hitting the locally-started PXE, not nextnet**. The user flagged this concern about an earlier run; haven't fully tracked it down. Things to check:

- `e2e/playwright.config.ts` — `globalSetup` should spawn `aztec start --local-network` unless `E2E_SKIP_NETWORK=1`.
- `scripts/bootstrap-local-networks.js` — writes `apps/fpc-operator/src/config/networks/local.json`. Must run before fpc-operator dev server boots.
- `e2e/tests/04-fpc-signup.spec.ts:76-82` — sets `localStorage.aztec_kit_network = "local"` via `page.addInitScript()` before navigating.
- In CI logs, grep for `aztecNodeUrl` and confirm it's `localhost:8080` and not `nextnet.aztec-labs.com`.

If the test is silently falling back to nextnet, all bisect results are meaningless. **Resolve this first.**

## Suspect commit window: 20260521 → 20260522

```
b36f2f7af5 feat: merge-train/avm (#23332)
8374744bdf feat: merge-train/barretenberg (#23455)
b8cc5e9905 feat: merge-train/fairies (#23447)
83c6b27517 refactor(aztec-nr)!: remove array-based emit log unsafe APIs, rename BoundedVec variants (#23438)
0b6bf902ee feat(avm)!: Remove `is_infinite` flag from AVM ECC & update noir submodule (#23342)
                    └─ bumps noir/noir-repo from 4f77d904 → f1a4575a (ACIR + EmbeddedCurvePoint format)
0a6690d6e4 feat!: azip 8 public key hashes (#23159)
                    └─ getPublicKeysAndPartialAddress oracle handler now does
                       async wasm hash calls (hashPublicKey) inside foreign-call dispatch
a93ead29d5 feat(avm)!: add immutables_hash to get_contract_instance opcode (#23152)
82e5736742 feat!: update address derivation (#23151)
a1e719358d feat!: add immutables_hash to contract instance (#23091)
```

**Strongest candidate**: #23159 (AZIP-8 public key hashes). Before this PR, `getPublicKeysAndPartialAddress` was sync data marshaling. After, it does `await hashPublicKey(point)` (Poseidon2 via wasm) three times per invocation. That turns an oracle handler from "return data" into "do async wasm work during the wasm→JS callback", which is precisely the shape that would surface an executor reentry bug.

## What we've tried locally (all eliminated)

| Hypothesis | Result |
| --- | --- |
| Vite was pre-bundling `@aztec/noir-acvm_js` into two JS wrappers around one wasm | Excluding it from `optimizeDeps` changed the panic from `RefCell` to `memory OOB`. Real fix, but not the root cause. **Keep the exclude** ([packages/common/src/vite/aztecVitePlugin.ts](packages/common/src/vite/aztecVitePlugin.ts) also excludes `@aztec/noir-noirc_abi` defensively). |
| Microtask yield before recursive `executePrivateFunction` | Made the error explicit (`closure invoked recursively`) — diagnostic, not fix. Reverted. |
| Contract artifact shape mismatch | Verified `getContractInstance` (11 fields) and `getPublicKeysAndPartialAddress` (6 fields) wires match between PXE and aztec-nr at 20260527. Not the issue. |
| Recursive simulation is the architectural bug | **Wrong** — user pointed out this is the standard Aztec simulator pattern. Years of working code. |

## Bisect procedure (Linux)

### One-time setup

```bash
git clone git@github.com:aztec-labs-eng/aztec-kit.git
cd aztec-kit
git fetch --all --tags
```

Install Aztec CLI + node (if not already): see `.github/workflows/ci.yml` action `./.github/actions/setup` for the canonical install steps.

### Reproduce the panic against a target nightly

1. **Branch off `gj/update_nightly`** (has the latest code that triggers the bug):
   ```bash
   git checkout gj/update_nightly
   git checkout -b gj/bisect-<TARGET>
   ```
2. **Pin all deps** to the target:
   ```bash
   node scripts/update.js --version 5.0.0-nightly.<TARGET> --skip-aztec-up --skip-compile
   ```
   This rewrites every `package.json` under `apps/`, `packages/`, `e2e/`, and every `Nargo.toml` under `packages/contracts/aztec/noir/`, then runs `yarn install`.
3. **Adjust code for the target's APIs** (see "Per-target code rollbacks" below — different code adjustments are needed depending on which target nightly).
4. **Compile contracts**:
   ```bash
   cd packages/contracts/aztec && yarn build && cd -
   ```
5. **Verify locally**:
   ```bash
   yarn typecheck                                 # all packages should pass
   yarn workspace @aztec-kit/embedded-wallet test  # 16/16 should pass
   ```
6. **Run the e2e fpc-signup flow against a local network**:
   ```bash
   # Spawns aztec --local-network, builds + serves the three apps, runs the test.
   yarn workspace @aztec-kit/e2e test --grep "fpc signs up"
   ```
7. **Interpret**:
   - Test passes → target nightly does NOT have the regression. Bisect later.
   - Test fails with `JsFuture::finish` / `RefCell` / `memory OOB` / `closure invoked recursively` → target HAS the regression. Bisect earlier.
8. **Push + open a PR against `next`** to capture the CI result for later reference:
   ```bash
   git add -A
   git commit -m "bisect: pin <TARGET>"
   git push -u origin gj/bisect-<TARGET>
   gh pr create --base next --title "bisect: <TARGET>" --body "..."
   ```

### Per-target code rollbacks

The contract source on `gj/update_nightly` uses APIs that didn't exist at earlier nightlies. When pinning to an older nightly, you'll get compile errors and need to roll back. Quick reference:

| API | When it landed | Older equivalent |
| --- | --- | --- |
| `AccountManager.create(wallet, secret, contract, { salt, immutablesHash })` | `20260526` | At ≤20260525: use the manual instance + `createAccountManagerWithInstance` from [packages/embedded-wallet/src/account-manager-from-instance.ts](packages/embedded-wallet/src/account-manager-from-instance.ts). The bisect branch `gj/bisect-20260522` already has this restored — diff it if you need the exact shape. |
| `#[aztec(AztecConfig::new().custom_sync_state(crate::no_sync))]` | mid-to-late 20260520s | Older: plain `#[aztec]` + `unconstrained fn sync_state(_scope: AztecAddress) {}` inside the contract block. |
| `PrivateContext::push_nullifier_unsafe(...)` | late 20260520s | Older: `push_nullifier(...)`. Used by `token` and `proof_of_password` contracts. |
| `verify_private_authwit(...) -> Field` (no `pub`) | new noir | Older noir compiler requires `pub`: `-> pub Field`. Same for `lookup_validity(...) -> pub bool`. |

Look at the diff in `gj/bisect-20260522` for the concrete rollback example.

### Suggested bisect schedule

Assuming PR #19 (`20260522`) reproduces the panic:

```
20260521 ✓ known good
20260522 ← PR #19 (test next)
20260524
20260525
20260527 ✗ known broken
```

If `20260522` reproduces → suspect set is the 9 commits in the 0521→0522 window. Bisect by reverting subsets of those commits on top of `gj/bisect-20260522`:

1. **First revert candidate**: `0a6690d6e4` (AZIP-8 PublicKeys). Highest structural likelihood. If reverting fixes calibrate, you've found it.
2. **Second**: `0b6bf902ee` (noir submodule bump). Requires re-pinning the noir submodule SHA, which is gated by aztec-packages' build infra — likely needs a custom aztec-packages branch + a published nightly that uses that submodule. Less straightforward.
3. **Third**: the immutables_hash stack (`a1e719358d`, `82e5736742`, `a93ead29d5`). These changed wire shapes for `getContractInstance` and address derivation.

If `20260522` does NOT reproduce → bisect forward: try `20260525`, then narrow to a 2-3 nightly window, then individual PRs.

## Useful greps once you have a panic

When the panic fires in CI, the smoking-gun lines are:

```
[browser:info] Simulating transaction execution request to 0x7b4ff070 at 0x…
[browser:error] panicked at wasm-bindgen-futures-0.4.63/src/lib.rs:164:39: RefCell already borrowed
```

or:

```
acvm_js.wasm.<wasm_bindgen_futures::JsFuture<T> as core::convert::From<…>>::from::finish
…
Error: closure invoked recursively or after being dropped
```

Selector `0x7b4ff070` is `SubscriptionFPC.calibrate`. If you see a different selector firing the panic, it's a different code path and worth investigating separately.

## Files modified on `gj/bisect-20260522` (this branch's diff)

```
apps/{bridge,fpc-operator,swap}/package.json       — pin to 20260522
e2e/package.json                                    — pin to 20260522
packages/{common,contracts/aztec,embedded-wallet}/package.json — pin to 20260522
packages/contracts/aztec/noir/*/Nargo.toml          — pin to 20260522
packages/contracts/aztec/noir/schnorr_initializerless_account/src/main.nr
                                                    — revert AztecConfig + add pub
packages/contracts/aztec/noir/{token,proof_of_password}/src/main.nr
                                                    — rename push_nullifier_unsafe → push_nullifier
packages/embedded-wallet/src/embedded-wallet.ts     — use manual instance + wrapper
packages/embedded-wallet/src/account-manager-from-instance.ts (new)
                                                    — JS-public ctor wrapper
yarn.lock                                            — re-resolved
```

Embedded-wallet vitest passes (16/16) on this branch.

## Loose ends

- The user can't reproduce locally on Mac due to a separate bug preventing `aztec start --local-network` from booting. Linux should work; if not, fix that first.
- Earlier in our session I made a wallet-side migration to the AZIP-9 `immutables_hash` pattern. That code lives on `gj/update_nightly`. If your bisect requires reverting `immutables_hash` from aztec-packages, you'll also need to revert that wallet-side migration (or temporarily go back to the salt-abuse pattern). The `gj/bisect-20260522` branch preserves the `immutables_hash` wallet code with a local AccountManager wrapper, so it should work — but only as long as the aztec-packages target HAS the `immutables_hash` field on `ContractInstance` (which lands at 20260522 via PR #23091).

Good luck — ping when you have a clean panic vs. clean run on an intermediate nightly and we can narrow further from there.
