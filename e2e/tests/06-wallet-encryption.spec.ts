import { test, expect } from "../fixtures/test-base.ts";
import type { Page } from "@playwright/test";

/**
 * Spec 06 — at-rest encryption of the embedded wallet's OPFS data.
 *
 * Drives the swap onboarding through the "use embedded wallet" path,
 * then verifies that:
 *   (a) IndexedDB contains the encryption key (goswap-wallet-keys /
 *       keys / wallet-encryption-key).
 *   (b) The OPFS-backed wallet SQLite file's first 16 bytes do NOT match
 *       the plaintext SQLite magic "SQLite format 3\0" — i.e. the on-disk
 *       header is encrypted.
 *   (c) Reloading the tab restores the wallet (same address) without
 *       re-onboarding, which proves the key round-trips through IndexedDB
 *       correctly.
 *
 * Does not depend on the 01-05 dependency chain — only needs local Aztec
 * network up (from globalSetup) and the swap dev server.
 *
 * NOTE: we use `data-address` (set as soon as the embedded wallet finishes
 * createInitializerlessAccount) as the readiness signal — NOT
 * `data-connected="true"`, which only flips after the full drip flow that
 * requires the FPC contract chain from specs 01-04. Encryption is set up
 * at wallet-creation time, so by the time `data-address` is populated
 * the OPFS bytes are already encrypted.
 */

const SQLITE_MAGIC = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
];

async function openOnboardingAndPickEmbedded(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("goswap_network", "local");
    } catch {
      /* ignore */
    }
  });
  await page.goto("/");

  const walletChip = page.getByTestId("wallet-chip");
  await walletChip.waitFor({ timeout: 60_000 });
  await expect(walletChip).toHaveAttribute("data-connected", "false", { timeout: 30_000 });
  await walletChip.click();

  // Onboarding modal renders WalletDiscovery first. Click "Continue
  // without external wallet".
  await page.getByTestId("onboarding-use-embedded").click();
}

test.describe.serial("wallet encryption at rest", () => {
  test.slow();

  test("wallet OPFS bytes are encrypted; IndexedDB holds the key; reload restores", async ({
    page,
  }) => {
    await openOnboardingAndPickEmbedded(page);

    // Wait for the embedded wallet's account to be created. The chip's
    // `data-address` populates as soon as createInitializerlessAccount
    // resolves — that's our "encryption setup is done" signal. See the
    // file-level NOTE for why we don't use `data-connected="true"`.
    const walletChip = page.getByTestId("wallet-chip");
    await expect(async () => {
      const addr = await walletChip.getAttribute("data-address");
      expect(addr).toBeTruthy();
      expect(addr).not.toBe("");
    }).toPass({ timeout: 120_000 });

    // (a) IndexedDB has the key.
    const dbExists = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      return dbs.some((d) => d.name === "goswap-wallet-keys");
    });
    expect(dbExists, "goswap-wallet-keys IndexedDB should exist after onboarding").toBe(true);

    const hasKey = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const req = indexedDB.open("goswap-wallet-keys");
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction("keys", "readonly");
            const get = tx.objectStore("keys").get("wallet-encryption-key");
            get.onsuccess = () => {
              resolve(!!get.result);
              db.close();
            };
            get.onerror = () => {
              resolve(false);
              db.close();
            };
          };
          req.onerror = () => resolve(false);
        }),
    );
    expect(hasKey, "encryption key record should exist").toBe(true);

    // (b) On-disk wallet bytes don't begin with the SQLite plaintext magic.
    // __aztecStores is registered when inspect: import.meta.env.DEV is true.
    // The e2e suite runs against the dev server (yarn workspace … dev), so DEV=true.
    const firstBytes = await page.evaluate(async () => {
      const stores = (
        window as unknown as {
          __aztecStores?: { wallet: { exportDb(): Promise<Uint8Array> } };
        }
      ).__aztecStores;
      if (!stores) throw new Error("__aztecStores not registered");
      const bytes = await stores.wallet.exportDb();
      return Array.from(bytes.slice(0, 16));
    });
    expect(
      firstBytes,
      "wallet OPFS file header should NOT be plaintext SQLite magic",
    ).not.toEqual(SQLITE_MAGIC);
    expect(firstBytes.length, "exportDb returned fewer than 16 bytes — store is empty?").toBe(16);

    // (c) Capture the current wallet address, reload, verify same address.
    const addressBefore = await walletChip.getAttribute("data-address");
    expect(addressBefore, "wallet-chip should expose the address").toBeTruthy();

    await page.reload();
    // After reload, wait for the address to populate again. Same
    // readiness signal as above — see file-level NOTE.
    await expect(async () => {
      const addr = await page.getByTestId("wallet-chip").getAttribute("data-address");
      expect(addr).toBeTruthy();
      expect(addr).not.toBe("");
    }).toPass({ timeout: 120_000 });
    const addressAfter = await page.getByTestId("wallet-chip").getAttribute("data-address");
    expect(
      addressAfter,
      "address must round-trip across reload (key from IndexedDB decrypts OPFS)",
    ).toBe(addressBefore);
  });
});
