/**
 * Thrown by `EmbeddedWallet.create` when the upstream sqlite3mc store reports
 * a page-decrypt error during `open()`. Indicates that the supplied
 * `encryptionKey` does not match the key that wrote the on-disk data — either
 * the key was rotated/lost, or the data was written without encryption.
 *
 * Consumers handle this by wiping the affected OPFS store + re-onboarding,
 * or by surfacing a fatal error.
 */
export type StoreName = "pxe" | "wallet";

export class EncryptionKeyMismatchError extends Error {
  readonly storeName: StoreName;
  // `Error.cause` lands in ES2022; the package is on `target: ES2020`, so
  // we declare and assign it ourselves instead of using the two-arg Error
  // constructor. The runtime targets (Node 18+, modern browsers) all support
  // it — this is purely a typing accommodation.
  readonly cause: unknown;

  constructor(opts: { storeName: StoreName; cause: unknown }) {
    super(
      `Failed to open ${opts.storeName} store: encryption key mismatch ` +
        `(data is encrypted with a different key, or unencrypted data was opened with a key)`,
    );
    this.name = "EncryptionKeyMismatchError";
    this.storeName = opts.storeName;
    this.cause = opts.cause;
  }
}
