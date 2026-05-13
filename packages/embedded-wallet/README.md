# @aztec-kit/embedded-wallet

Embeddable Aztec wallet backed by `SchnorrInitializerlessAccount`. Thin layer on top of `@aztec/wallets` that ships pre-wired React components + hooks for dApps.

## Subpath exports

| Import                          | Contents                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@aztec-kit/embedded-wallet`    | Core wallet logic: `createSchnorrInitializerlessAccount`, `deployWithImmutables`, `computeContractSalt`, capsule helpers. No React. |
| `@aztec-kit/embedded-wallet/ui` | React components + hooks: `EmbeddedWalletProvider`, `useEmbeddedWallet`, connect button, onboarding modal.                          |

## Why "initializerless"?

The account contract has no `initialize` entrypoint. The signing public key is passed via a capsule on every call and its hash is baked into the contract salt, so the contract's address commits to the key without requiring a deploy-time init tx. Deploy and the first send can land in the same tx.

Helpers you'll actually use:

```ts
import {
  createSchnorrInitializerlessAccount, // secretKey → { signingKey, signingPublicKey, actualSalt }
  computeImmutablesAddress, // predict address without touching a wallet
  deployWithImmutables, // register + deploy through an EmbeddedWallet
  createSigningKeyCapsule, // build the capsule every call needs
} from "@aztec-kit/embedded-wallet";
```

## Testing

```bash
yarn workspace @aztec-kit/embedded-wallet test
```

Uses the in-process `setupLocalNetwork` fixture from `@aztec-kit/common/testing` — no external `aztec start --local-network` needed.

## At-rest encryption

`EmbeddedWalletExtraOptions.getEncryptionKey` enables sqlite3mc page-level
encryption (ChaCha20) on both the PXE store and the walletDB store.

```ts
const wallet = await EmbeddedWallet.create(node, {
  getEncryptionKey: async () => new Uint8Array(32), // your 32-byte key
});
```

Rules:

- The callback is invoked **once per store** (twice total per `create()`).
- It must return a **fresh 32-byte `Uint8Array` each call** — the upstream
  `AztecSQLiteOPFSStore.open()` transfers the buffer to its worker, detaching
  the caller's view. Sharing a buffer between calls produces an empty key on
  the second call.
- Not compatible with `ephemeral: true` (sqlite3mc cannot encrypt `:memory:`
  databases). Combining the two throws synchronously.
- If the on-disk data was encrypted with a different key (or wasn't
  encrypted at all), `create()` throws `EmbeddedWalletEncryptionError`
  (re-exported from `@aztec/wallets/embedded`). Catch it to surface a "wipe
  and re-onboard" recovery path.

```ts
import { EmbeddedWalletEncryptionError } from "@aztec-kit/embedded-wallet";

try {
  wallet = await EmbeddedWallet.create(node, { getEncryptionKey });
} catch (err) {
  if (err instanceof EmbeddedWalletEncryptionError) {
    // err.storeName is "pxe" or "wallet" — tells you which store failed.
    // err.cause is the underlying SqliteEncryptionError from kv-store.
    // Wipe the relevant OPFS dir + your stored key, prompt the user to reload.
  } else {
    throw err;
  }
}
```

See `apps/swap/src/services/keyService.ts` for a reference implementation
that generates a random AES-256 `CryptoKey`, stores it in IndexedDB, and
handles wipe-and-restart on key mismatch.
