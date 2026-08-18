/**
 * Spec 00 — L1 wallet discovery & selection in the bridge app (EIP-6963).
 *
 * Regression coverage for competing injected providers: multiple wallet
 * extensions used to fight over `window.ethereum`, and the app would sign
 * with whichever won the injection race rather than the wallet the user
 * connected. The app now discovers wallets via EIP-6963 announcements and
 * routes everything through the selected provider.
 *
 * Independent of the aztec network and of every other spec: it only needs
 * the bridge dev server. All providers are synthetic page-side stubs — no
 * Node-backed wallet, no L1. Asserts:
 *   - no auto-connect on first visit, even when a wallet reports accounts
 *   - the picker lists every announced wallet
 *   - selecting a wallet that LOST the `window.ethereum` race connects it
 *   - reload silently reconnects to the stored wallet
 *   - disconnect clears the stored selection durably
 *   - a single installed wallet connects directly, without the picker
 */
import { test, expect, type Page } from "@playwright/test";

const WALLET_A_ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B_ACCOUNT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Must match WalletContext's STORAGE_KEY in the bridge app. */
const WALLET_RDNS_KEY = "gobridge:l1-wallet-rdns";

interface FakeWallet {
  name: string;
  rdns: string;
  account: string;
}

/**
 * Injects page-side EIP-6963 wallets. Each is a minimal EIP-1193 stub that
 * reports a fixed account on the expected chain (31337) and accepts the
 * connect/permission methods the app issues. Only the FIRST wallet is
 * assigned to `window.ethereum`, simulating the injection race.
 */
async function injectWallets(
  page: Page,
  wallets: FakeWallet[],
  opts: { storedRdns?: string } = {},
): Promise<void> {
  await page.addInitScript(
    ({
      wallets,
      storedRdns,
      rdnsKey,
    }: {
      wallets: FakeWallet[];
      storedRdns?: string;
      rdnsKey: string;
    }) => {
      localStorage.setItem("aztec_kit_network", "local");
      if (storedRdns) localStorage.setItem(rdnsKey, storedRdns);

      const icon =
        'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="%23345"/></svg>';

      const details = wallets.map((w, i) => ({
        info: Object.freeze({
          uuid: `00000000-0000-4000-8000-00000000000${i + 1}`,
          name: w.name,
          icon,
          rdns: w.rdns,
        }),
        provider: {
          async request({ method }: { method: string; params?: unknown[] }) {
            switch (method) {
              case "eth_accounts":
              case "eth_requestAccounts":
                return [w.account];
              case "eth_chainId":
                return "0x7a69"; // 31337 — matches the `local` network config
              case "wallet_switchEthereumChain":
              case "wallet_revokePermissions":
                return null;
              case "wallet_requestPermissions":
                return [{ parentCapability: "eth_accounts" }];
              default:
                throw new Error(`fake wallet: unsupported method ${method}`);
            }
          },
          on() {},
          removeListener() {},
        },
      }));

      Object.defineProperty(window, "ethereum", {
        value: details[0].provider,
        configurable: true,
      });
      const announceAll = () =>
        details.forEach((detail) =>
          window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail })),
        );
      window.addEventListener("eip6963:requestProvider", announceAll);
      announceAll();
    },
    { wallets, storedRdns: opts.storedRdns, rdnsKey: WALLET_RDNS_KEY },
  );
}

test.describe("bridge L1 wallet discovery (EIP-6963)", () => {
  test("picker lists both wallets, connects the chosen one, reconnects silently", async ({
    page,
  }) => {
    await injectWallets(page, [
      { name: "Wallet Alpha", rdns: "test.alpha", account: WALLET_A_ACCOUNT },
      { name: "Wallet Beta", rdns: "test.beta", account: WALLET_B_ACCOUNT },
    ]);
    await page.goto("/");

    // Not connected on load: eth_accounts is non-empty but nothing was
    // explicitly connected before (no stored rdns).
    const chip = page.getByRole("button", { name: "Connect Wallet" }).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await chip.click();

    // Picker shows both discovered wallets.
    await expect(page.getByText("Select a wallet")).toBeVisible();
    await expect(page.getByText("Wallet Alpha")).toBeVisible();
    await expect(page.getByText("Wallet Beta")).toBeVisible();

    // Pick Beta — the wallet that LOST the window.ethereum race. Its account
    // showing up proves calls route through the selected provider, not the
    // race winner.
    await page.getByText("Wallet Beta").click();
    await expect(page.getByText("0xbbbb...bbbb").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Select a wallet")).not.toBeVisible();

    // Reload: silent reconnect to Beta via the stored rdns.
    await page.reload();
    await expect(page.getByText("0xbbbb...bbbb").first()).toBeVisible({ timeout: 30_000 });

    // Disconnect clears the stored selection; reload stays disconnected.
    await page.getByText("0xbbbb...bbbb").first().click();
    await page.getByText("Disconnect").click();
    await expect(page.getByRole("button", { name: "Connect Wallet" }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Connect Wallet" }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test("single wallet connects directly without picker", async ({ page }) => {
    await injectWallets(page, [
      { name: "Wallet Alpha", rdns: "test.alpha", account: WALLET_A_ACCOUNT },
    ]);
    await page.goto("/");

    const chip = page.getByRole("button", { name: "Connect Wallet" }).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await chip.click();

    await expect(page.getByText("0xaaaa...aaaa").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Select a wallet")).not.toBeVisible();
  });

  test("stored rdns auto-connects on load (inject-l1-wallet fixture parity)", async ({ page }) => {
    await injectWallets(
      page,
      [{ name: "Wallet Alpha", rdns: "test.alpha", account: WALLET_A_ACCOUNT }],
      { storedRdns: "test.alpha" },
    );
    await page.goto("/");

    await expect(page.getByText("0xaaaa...aaaa").first()).toBeVisible({ timeout: 30_000 });
  });
});
