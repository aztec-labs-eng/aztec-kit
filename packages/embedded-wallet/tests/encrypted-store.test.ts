import { describe, it, expect } from "vitest";
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
