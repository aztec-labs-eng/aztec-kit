/**
 * Wallet Service
 * Pure functions for wallet-related operations
 */

import type { AztecNode } from "@aztec/aztec.js/node";
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { ChainInfo } from "@aztec/aztec.js/account";
import { Fr } from "@aztec/aztec.js/fields";
import {
  WalletManager,
  type WalletProvider,
  type PendingConnection,
  type DiscoverySession,
} from "@aztec/wallet-sdk/manager";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { EmbeddedWallet, EncryptionKeyMismatchError } from "@aztec-kit/embedded-wallet";
import type { NetworkConfig } from "../config/networks";
import {
  ensurePlaintextMigrationDone,
  getOrCreateWalletEncryptionKey,
  exportRawKey,
  resetWalletKeyAndStorage,
} from "./keyService";

/**
 * Web wallet URLs to probe during discovery.
 * Set VITE_WEB_WALLET_URL in .env or CI to override the default dev URL.
 */
const WEB_WALLET_URLS: string[] = [import.meta.env.VITE_WEB_WALLET_URL ?? "http://localhost:3001"];

const APP_ID = "goswap";

/**
 * Creates an embedded wallet and ensures it has an account.
 * Uses initializerless Schnorr accounts — no on-chain deployment needed.
 * The wallet's internal DB persists the account, so the same address is restored on reload.
 *
 * The wallet's OPFS-backed PXE + walletDB stores are encrypted at rest with
 * a random AES-256 key stored in IndexedDB (see keyService). On rollout day
 * any pre-existing plaintext OPFS dirs are wiped so the user is force-re-onboarded
 * with encrypted storage.
 */
export async function createEmbeddedWallet(
  node: AztecNode,
): Promise<{ wallet: EmbeddedWallet; address: AztecAddress }> {
  const { rollupAddress } = await node.getL1ContractAddresses();
  const rollupHex = rollupAddress.toString();

  // `VITE_WALLET_STORE=indexeddb` runs the wallet on the (soon-to-be-deprecated)
  // IndexedDB kv-store backend so CI keeps getting signal on it. That backend
  // has no at-rest encryption, so the encryption-key + plaintext-OPFS migration
  // dance below is sqlite-opfs-only.
  const storeBackend =
    import.meta.env.VITE_WALLET_STORE === "indexeddb" ? "indexeddb" : "sqlite-opfs";

  let getEncryptionKey: (() => Promise<Uint8Array>) | undefined;
  if (storeBackend === "sqlite-opfs") {
    await ensurePlaintextMigrationDone(rollupHex);
    const cryptoKey = await getOrCreateWalletEncryptionKey();
    getEncryptionKey = () => exportRawKey(cryptoKey);
  }

  // `VITE_DISABLE_PROVER=1` turns off bb.js proving — only used in CI e2e
  // where proving starves the Aztec node's event loop on the 4 vCPU runner.
  const proverEnabled = import.meta.env.VITE_DISABLE_PROVER !== "1";

  let wallet: EmbeddedWallet;
  try {
    wallet = await EmbeddedWallet.create(node, {
      inspect: import.meta.env.DEV,
      pxe: { proverEnabled },
      storeBackend,
      getEncryptionKey,
    });
  } catch (err) {
    if (err instanceof EncryptionKeyMismatchError) {
      // On-disk data is encrypted with a key we no longer have (user
      // cleared IndexedDB but not OPFS, or some other key/data drift).
      // Wipe both sides and force a re-onboard via reload.
      await resetWalletKeyAndStorage(rollupHex);
      throw new Error(
        "Wallet storage was reset due to an encryption key mismatch. Please reload the page.",
      );
    }
    throw err;
  }

  let accountManager = await wallet.loadStoredAccount();
  if (!accountManager) {
    accountManager = await wallet.createInitializerlessAccount();
  }
  return { wallet, address: accountManager.address };
}

/**
 * Gets the chain info from a network configuration
 */
export function getChainInfo(network: NetworkConfig): ChainInfo {
  return {
    chainId: Fr.fromString(network.chainId),
    version: Fr.fromString(network.rollupVersion),
  };
}

/**
 * Starts wallet discovery process (extension + web wallets in parallel).
 * Returns a DiscoverySession that yields providers as they are discovered.
 */
export function discoverWallets(chainInfo: ChainInfo, timeout?: number): DiscoverySession {
  return WalletManager.configure({
    extensions: { enabled: true },
    webWallets: { urls: WEB_WALLET_URLS },
  }).getAvailableWallets({
    chainInfo,
    appId: APP_ID,
    timeout,
  });
}

/**
 * Initiates a secure connection with a wallet provider
 * Returns a PendingConnection for emoji verification
 */
export async function initiateConnection(provider: WalletProvider): Promise<PendingConnection> {
  return provider.establishSecureChannel(APP_ID);
}

/**
 * Confirms a pending connection after emoji verification
 * Returns the connected wallet
 */
export async function confirmConnection(pendingConnection: PendingConnection): Promise<Wallet> {
  return pendingConnection.confirm();
}

/**
 * Cancels a pending connection
 */
export function cancelConnection(pendingConnection: PendingConnection): void {
  pendingConnection.cancel();
}

/**
 * Disconnects from a wallet provider
 */
export async function disconnectProvider(provider: WalletProvider): Promise<void> {
  if (provider.disconnect) {
    await provider.disconnect();
  }
}
