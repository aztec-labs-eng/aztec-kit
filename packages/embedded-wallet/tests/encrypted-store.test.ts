/**
 * Downstream-specific encryption tests.
 *
 * The bulk of encryption-shaped behavior — typed errors, two-store cleanup,
 * decrypt-failure detection, key buffer transfer — now lives in upstream's
 * `@aztec/wallets/embedded` (`openEncryptedEmbeddedStores`) and is exercised
 * by upstream's own test suite. The only thing this package still owns is
 * the `ephemeral + getEncryptionKey` synchronous guard on `create()`.
 *
 * Other behaviors (key threading, error wrapping, sibling-store cleanup)
 * were removed when their implementation moved upstream — re-asserting them
 * here would just duplicate upstream coverage.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@aztec/kv-store/sqlite-opfs", () => ({
  AztecSQLiteOPFSStore: { open: vi.fn() },
}));

const { EmbeddedWallet } = await import("../src/embedded-wallet.js");
const { AztecSQLiteOPFSStore } = await import("@aztec/kv-store/sqlite-opfs");

function fakeNode() {
  return {
    getL1ContractAddresses: async () => ({
      rollupAddress: { toString: () => "0xrollupstub" },
    }),
  } as never;
}

describe("EmbeddedWallet.create — encryption guards", () => {
  it("throws synchronously when ephemeral=true and getEncryptionKey is set", async () => {
    await expect(
      EmbeddedWallet.create(fakeNode(), {
        ephemeral: true,
        getEncryptionKey: async () => new Uint8Array(32),
      }),
    ).rejects.toThrow(/ephemeral/i);
    expect(AztecSQLiteOPFSStore.open).not.toHaveBeenCalled();
  });
});
