/**
 * Shared CLI / deploy-script plumbing for the app scripts folders.
 *
 * Importers are Node-only — this module pulls in PXE + aztec.js + @aztec/accounts
 * which aren't browser-safe. The `@aztec-kit/common/testing` subpath export
 * keeps it out of the default browser bundle entry.
 */
export {
  VALID_NETWORKS,
  NETWORK_URLS,
  L1_DEFAULTS,
  LOCAL_L1_FUNDER_KEY,
  VALID_PAYMENT_MODES,
  DEFAULT_PAYMENT_MODE,
  resolveL1Funder,
  bridgeMode,
  apiKeyForNetwork,
  type NetworkName,
  type PaymentMode,
} from "./network-config.ts";

export { parseNetwork, parsePaymentMode, parseAddressList } from "./cli.ts";

export {
  getSponsoredFPCContract,
  buildPaymentMethod,
  setupWallet,
  type PaymentMethod,
  type SetupWalletResult,
} from "./wallet-setup.ts";

export { loadOrCreateSecret, getSalt, getAdmin } from "./admin.ts";

export {
  setupLocalNetwork,
  setupLocalNetworkCli,
  TEST_FEE_PADDING,
  type LocalNetwork,
  type LocalNetworkOptions,
  type LocalNetworkCli,
  type LocalNetworkCliOptions,
} from "./local-network.ts";

export {
  ensureAztecBinsInPath,
  resolveAnvilBinary,
  spawnTracked,
  killTracked,
  type SpawnTrackedOptions,
} from "./spawn.ts";

export {
  BACKUP_VERSION,
  resolveFpcAdminBackupPath,
  readFpcAdminBackup,
  writeFpcAdminBackup,
  type FpcAdminBackup,
  type SignedUpApp,
  type StoredFPC,
} from "./fpc-admin-backup.ts";
