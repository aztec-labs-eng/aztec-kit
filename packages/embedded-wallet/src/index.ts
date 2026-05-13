export { EmbeddedWallet, INITIALIZERLESS_TYPE } from "./embedded-wallet";
export {
  SchnorrInitializerlessAccount,
  SchnorrInitializerlessAuthWitnessProvider,
  createSchnorrInitializerlessAccount,
  computeContractSalt,
  serializeSigningKey,
  createSigningKeyCapsule,
  type SigningPublicKey,
} from "./initializerless-account";
export { txProgress, type TxPhase, type PhaseTiming, type TxProgressEvent } from "./tx-progress";
export {
  computeContractSalt as computeImmutablesSalt,
  createImmutablesCapsule,
  createImmutablesInstance,
  deployWithImmutables,
  computeImmutablesAddress,
  IMMUTABLES_SLOT,
} from "./immutables";
// Encryption-failure surface now ships upstream — re-export
// `EmbeddedWalletEncryptionError` and its `storeName` discriminant so apps
// continue to import their error class from this package.
export { EmbeddedWalletEncryptionError } from "@aztec/wallets/embedded";
export type { EmbeddedStoreName } from "@aztec/wallets/embedded";
