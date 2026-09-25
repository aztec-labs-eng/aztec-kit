# VENDORED — do not edit

This directory is a vendored copy of the Aztec deploy framework from
`AztecProtocol/aztec-packages:yarn-project/aztec/src/deploy/` at tag `v5.3.0-nightly.20260827`
(published there as the `@aztec/aztec/deploy` subpath since 5.2.0). The v6 line
(`aztec-labs-eng/aztec-node`, `@aztec-labs/*`) does not ship it: `@aztec-labs/aztec@6.0.0-rc.1`
exports only `.` and `./testing`. Fix bugs upstream, then re-copy.

**Kill switch**: on the first `@aztec-labs/aztec` release that ships a `./deploy` subpath, delete
this directory and point the façade (`../deploy.ts`) at the published package. Nothing else
imports these files directly.

Deltas vs upstream (each marked with a `VENDORED delta` comment where it isn't mechanical):

1. `@aztec/*` imports rewritten to `@aztec-labs/*` (v6 scope rename).
2. Relative import extensions rewritten `.js` → `.ts` (this repo runs sources under Node type
   stripping, which does not remap `.js` specifiers).
3. `fees.ts`: the SponsoredFPC helper is imported from `@aztec-labs/aztec` (upstream imports it
   from its own package's `local-network/` directory).
4. `FeeJuiceContract.at(wallet)` → `FeeJuiceContract.withWallet(wallet)` (v6 deprecation).
5. `state.ts`/`runner.ts`: `new Error(msg, { cause })` → `Object.assign(new Error(msg), { cause })`
   (this repo's ES2020 lib has no `ErrorOptions`).
6. `types.ts`: an `eslint-disable` on the `Steps` type's deliberate `any` (this repo's
   no-explicit-any rule).

Formatting differences (quotes, line width) from this repo's prettier are expected and not deltas.
