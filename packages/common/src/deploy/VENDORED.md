# VENDORED — do not edit

This directory is a vendored copy of the Aztec deploy framework from
`aztec-packages:yarn-project/aztec/src/deploy/` (branch `gj/upstream_deploy_framework`,
PR [#24685](https://github.com/AztecProtocol/aztec-packages/pull/24685)). Fix bugs upstream,
then re-copy.

**Kill switch**: on the first release that ships the `@aztec/aztec/deploy` subpath, delete this
directory and point the façade (`../deploy.ts`) at the published package. Nothing else imports
these files directly.

Deltas vs upstream (each marked with a `VENDORED delta` comment where it isn't mechanical):

1. Relative import extensions rewritten `.js` → `.ts` (this repo runs sources under Node type
   stripping, which does not remap `.js` specifiers).
2. `state.ts`: `new Error(msg, { cause })` → message concatenation (this repo's TS lib target).
3. `fees.ts`: the SponsoredFPC derivation is inlined (upstream imports a helper from its own
   package's `local-network/` directory, which does not exist here).
4. `types.ts`: an `eslint-disable` on the `Steps` type's deliberate `any` (this repo's
   no-explicit-any rule).

Formatting differences (quotes, line width) from this repo's prettier are expected and not deltas.
