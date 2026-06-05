/**
 * Encryption-key lifecycle for the swap app's embedded wallet.
 *
 * Strategy:
 *   - A 256-bit AES-GCM CryptoKey is generated once and stored in IndexedDB
 *     under `goswap-wallet-keys / keys / wallet-encryption-key`.
 *   - The key is `extractable: true` so we can `exportKey('raw', …)` to
 *     produce the 32 raw bytes that `@aztec/kv-store/sqlite-opfs` expects
 *     as its `encryptionKey` parameter.
 *   - On rollout day, any pre-existing PLAINTEXT OPFS dirs are wiped
 *     unconditionally (a one-shot migration gated by a flag in IndexedDB).
 *     Existing users are re-onboarded with a fresh address.
 *
 * Threat model: this is "encryption at rest" in the strict sense. It
 * protects the OPFS bytes against post-hoc forensics, NOT against code
 * running in the same origin (XSS, malicious extensions). For stronger
 * protection a future iteration could derive the key from a user
 * passphrase + PBKDF2; this module would be the place to plug that in.
 */

const DB_NAME = "goswap-wallet-keys";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const KEY_NAME = "wallet-encryption-key";
const MIGRATED_FLAG_KEY = "plaintext-opfs-migrated";

// ─── IndexedDB plumbing ─────────────────────────────────────────────────

function openKeyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteEntireDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    // `onblocked` fires when another tab holds an open connection.
    // We resolve anyway — best-effort cleanup; the next page load will
    // see no key record (or trigger another delete) and re-onboard.
    req.onblocked = () => resolve();
  });
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Returns the existing wallet-encryption CryptoKey from IndexedDB, or
 * generates, stores, and returns a fresh one if none exists.
 *
 * The key is generated with `extractable: true` so we can later
 * `exportKey('raw', …)` to feed the 32-byte Uint8Array API of
 * AztecSQLiteOPFSStore. Non-extractable would block that export and
 * defeat the purpose for this consumer.
 */
export async function getOrCreateWalletEncryptionKey(): Promise<CryptoKey> {
  const db = await openKeyDb();
  try {
    const existing = await idbGet<CryptoKey>(db, KEY_NAME);
    if (existing) return existing;

    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      /* extractable */ true,
      // AES-GCM usages are required by Web Crypto even though we only
      // ever exportKey('raw', …). encrypt/decrypt is the minimal set
      // that lets generateKey return a usable key.
      ["encrypt", "decrypt"],
    );
    await idbPut(db, KEY_NAME, key);
    return key;
  } finally {
    db.close();
  }
}

/**
 * Exports the raw 32 bytes of the CryptoKey. Returns a *fresh* Uint8Array
 * each call — the upstream sqlite-opfs open() transfers the buffer, so a
 * second open() call needs its own buffer.
 */
export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

/**
 * Wipes pre-existing PLAINTEXT OPFS dirs the FIRST time the encrypted
 * wallet runs in this origin. After that, gated by a flag in IndexedDB
 * so subsequent loads skip the wipe.
 *
 * Dir names match the convention in @aztec-kit/embedded-wallet's
 * EmbeddedWallet.create:
 *   - .aztec-kv-pxe-<rollupAddress>
 *   - .aztec-kv-wallet-<rollupAddress>
 *
 * Idempotent: if a dir doesn't exist, the removeEntry call throws a
 * NotFoundError which we swallow.
 */
export async function ensurePlaintextMigrationDone(rollupAddress: string): Promise<void> {
  const db = await openKeyDb();
  try {
    const flag = await idbGet<boolean>(db, MIGRATED_FLAG_KEY);
    if (flag === true) return;

    const root = await navigator.storage.getDirectory();
    for (const dirName of [`.aztec-kv-pxe-${rollupAddress}`, `.aztec-kv-wallet-${rollupAddress}`]) {
      await root.removeEntry(dirName, { recursive: true }).catch((err: unknown) => {
        // NotFoundError = dir wasn't there; happy path on a fresh install.
        if (err instanceof DOMException && err.name === "NotFoundError") return;
        throw err;
      });
    }

    await idbPut(db, MIGRATED_FLAG_KEY, true);
  } finally {
    db.close();
  }
}

/**
 * Called when EmbeddedWallet.create throws EmbeddedWalletEncryptionError.
 * Wipes:
 *   - The encrypted OPFS dirs for this rollup.
 *   - The CryptoKey in IndexedDB (so the next page load generates a
 *     fresh one).
 *
 * Caller is expected to surface a "storage was reset" error and require
 * a page reload. We deliberately do NOT trigger the reload from here —
 * the React app's error surface is the right place.
 */
export async function resetWalletKeyAndStorage(rollupAddress: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  for (const dirName of [`.aztec-kv-pxe-${rollupAddress}`, `.aztec-kv-wallet-${rollupAddress}`]) {
    await root.removeEntry(dirName, { recursive: true }).catch(() => {
      // Best-effort — if the dir is already gone or unremovable, we
      // still want to nuke the IDB key. Worst case the user reloads
      // and re-runs the reset.
    });
  }

  // Delete the entire key DB rather than the single record, so the
  // schema upgrade path stays sane (a fresh open will recreate it).
  await deleteEntireDb(DB_NAME).catch(() => {
    // Best-effort.
  });
}
