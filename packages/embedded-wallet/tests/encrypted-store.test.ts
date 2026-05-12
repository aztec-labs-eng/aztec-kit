import { describe, it, expect, vi, beforeEach } from "vitest";
import { EncryptionKeyMismatchError } from "../src/index.js";

describe("EncryptionKeyMismatchError", () => {
  it("is an Error subclass with storeName + cause", () => {
    const cause = new Error("file is not a database");
    const err = new EncryptionKeyMismatchError({ storeName: "pxe", cause });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(EncryptionKeyMismatchError);
    expect(err.name).toBe("EncryptionKeyMismatchError");
    expect(err.storeName).toBe("pxe");
    expect(err.cause).toBe(cause);
    expect(err.message).toContain("pxe");
    expect(err.message).toContain("encryption key");
  });

  it("accepts 'wallet' as a store name", () => {
    const err = new EncryptionKeyMismatchError({
      storeName: "wallet",
      cause: new Error("boom"),
    });
    expect(err.storeName).toBe("wallet");
  });
});

// ─── EmbeddedWallet.create — getEncryptionKey ──────────────────────────────
//
// The vitest environment here is Node-only (no OPFS), so we mock the upstream
// sqlite-opfs module rather than spinning up a real store. Each test makes
// AztecSQLiteOPFSStore.open() either throw (verifying the wrapping/validation
// logic) or return a stub (verifying call-shape + key threading).
//
// We never reach EmbeddedWalletBase.create() in these tests — either an
// open() throws and short-circuits, or our stub triggers a downstream throw
// after both opens. That's intentional: we're testing this package's wrapper
// behavior, not the base wallet.

vi.mock("@aztec/kv-store/sqlite-opfs", () => ({
  AztecSQLiteOPFSStore: { open: vi.fn() },
}));

const { EmbeddedWallet } = await import("../src/embedded-wallet.js");
const { AztecSQLiteOPFSStore } = await import("@aztec/kv-store/sqlite-opfs");

// Stub node — only `getL1ContractAddresses()` is reached before the first open().
function fakeNode() {
  return {
    getL1ContractAddresses: async () => ({
      rollupAddress: { toString: () => "0xrollupstub" },
    }),
  } as never;
}

describe("EmbeddedWallet.create — getEncryptionKey", () => {
  beforeEach(() => {
    vi.mocked(AztecSQLiteOPFSStore.open).mockReset();
  });

  it("throws synchronously when ephemeral=true and getEncryptionKey is set", async () => {
    await expect(
      EmbeddedWallet.create(fakeNode(), {
        ephemeral: true,
        getEncryptionKey: async () => new Uint8Array(32),
      }),
    ).rejects.toThrow(/ephemeral/i);
    expect(AztecSQLiteOPFSStore.open).not.toHaveBeenCalled();
  });

  it("passes a fresh 32-byte key to the first store.open() call when getEncryptionKey is set", async () => {
    const key1 = new Uint8Array(32).fill(0xaa);

    // Short-circuit on the first open() with a NON-decrypt error so it
    // propagates unchanged (not wrapped) — that way we never reach the
    // wallet open() and don't have to stub more state.
    vi.mocked(AztecSQLiteOPFSStore.open).mockImplementationOnce(async () => {
      throw new Error("__test_short_circuit__");
    });

    const getEncryptionKey = vi.fn(async () => key1);

    await expect(
      EmbeddedWallet.create(fakeNode(), { getEncryptionKey }),
    ).rejects.toThrow("__test_short_circuit__");

    expect(getEncryptionKey).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(AztecSQLiteOPFSStore.open).mock.calls[0];
    // 5th positional arg is encryptionKey.
    expect(firstCall[4]).toBe(key1);
    expect((firstCall[4] as Uint8Array).length).toBe(32);
  });

  it("calls open() twice (pxe + wallet) with a 32-byte key on the happy path", async () => {
    const key = new Uint8Array(32).fill(0xbb);
    let opens = 0;

    // Both opens succeed; the third boundary (super.create) trips on our
    // stub stores. We assert via the call count regardless of how super
    // fails — we only care that BOTH our open()s ran.
    vi.mocked(AztecSQLiteOPFSStore.open).mockImplementation(async () => {
      opens++;
      return { close: async () => {} } as never;
    });

    await expect(
      EmbeddedWallet.create(fakeNode(), {
        getEncryptionKey: async () => key.slice(),
      }),
    ).rejects.toThrow(); // any error past both opens is fine

    expect(opens).toBeGreaterThanOrEqual(2);
    const call0 = vi.mocked(AztecSQLiteOPFSStore.open).mock.calls[0];
    const call1 = vi.mocked(AztecSQLiteOPFSStore.open).mock.calls[1];
    expect((call0[4] as Uint8Array).length).toBe(32);
    expect((call1[4] as Uint8Array).length).toBe(32);
  });

  it("wraps the 'file is not a database' decrypt error as EncryptionKeyMismatchError on pxe", async () => {
    vi.mocked(AztecSQLiteOPFSStore.open).mockRejectedValueOnce(
      new Error("file is not a database"),
    );

    await expect(
      EmbeddedWallet.create(fakeNode(), {
        getEncryptionKey: async () => new Uint8Array(32),
      }),
    ).rejects.toMatchObject({
      name: "EncryptionKeyMismatchError",
      storeName: "pxe",
    });
  });

  it("wraps the 'file is encrypted or is not a database' decrypt error too", async () => {
    vi.mocked(AztecSQLiteOPFSStore.open).mockRejectedValueOnce(
      new Error("file is encrypted or is not a database"),
    );

    await expect(
      EmbeddedWallet.create(fakeNode(), {
        getEncryptionKey: async () => new Uint8Array(32),
      }),
    ).rejects.toMatchObject({
      name: "EncryptionKeyMismatchError",
    });
  });

  it("does NOT wrap unrelated errors (quota, worker crash, etc.)", async () => {
    vi.mocked(AztecSQLiteOPFSStore.open).mockRejectedValueOnce(
      new Error("QuotaExceededError: OPFS storage limit reached"),
    );

    await expect(
      EmbeddedWallet.create(fakeNode(), {
        getEncryptionKey: async () => new Uint8Array(32),
      }),
    ).rejects.toThrow(/QuotaExceededError/);

    // Sanity: it bubbled, not wrapped.
    vi.mocked(AztecSQLiteOPFSStore.open).mockRejectedValueOnce(
      new Error("QuotaExceededError: OPFS storage limit reached"),
    );
    await expect(
      EmbeddedWallet.create(fakeNode(), {
        getEncryptionKey: async () => new Uint8Array(32),
      }).catch((e: Error) => e.name),
    ).resolves.not.toBe("EncryptionKeyMismatchError");
  });

  it("wraps a decrypt error from the SECOND open() as storeName='wallet'", async () => {
    let n = 0;
    vi.mocked(AztecSQLiteOPFSStore.open).mockImplementation(async () => {
      n++;
      if (n === 1) return { close: async () => {} } as never;
      throw new Error("file is not a database");
    });

    await expect(
      EmbeddedWallet.create(fakeNode(), {
        getEncryptionKey: async () => new Uint8Array(32),
      }),
    ).rejects.toMatchObject({
      name: "EncryptionKeyMismatchError",
      storeName: "wallet",
    });
  });

  it("closes the pxe store if the wallet store throws on open", async () => {
    let pxeClosed = false;
    let n = 0;
    vi.mocked(AztecSQLiteOPFSStore.open).mockImplementation(async () => {
      n++;
      if (n === 1) {
        return {
          close: async () => {
            pxeClosed = true;
          },
        } as never;
      }
      throw new Error("file is not a database");
    });

    await expect(
      EmbeddedWallet.create(fakeNode(), {
        getEncryptionKey: async () => new Uint8Array(32),
      }),
    ).rejects.toThrow();
    expect(pxeClosed).toBe(true);
  });
});
