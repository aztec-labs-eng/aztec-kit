// Types
export type {
  L1Addresses,
  ClaimCredentials,
  BridgeStep,
  PendingBridge,
  MessageStatus,
} from "./types";

// L1 wallet discovery (EIP-6963)
export {
  subscribeWallets,
  getWalletsSnapshot,
  LEGACY_WALLET_RDNS,
  type EIP6963ProviderDetail,
  type EIP6963ProviderInfo,
} from "./l1/discovery";

// L1 wallet
export {
  switchChain,
  getConnectedAccount,
  connectWallet,
  getWalletChainId,
  requestAccountSwitch,
  revokeWalletPermissions,
} from "./l1/wallet";

// L1 clients & reads
export { getFeeJuiceBalance, getMintAmount } from "./l1/clients";

// L1 bridge
export { bridgeFeeJuice, bridgeMultiple, resumePendingBridge } from "./l1/bridge";

// L2 Aztec node
export {
  getAztecNode,
  fetchL1Addresses,
  pollMessageReadiness,
  waitForAztecTx,
} from "./l2/aztec-node";

// L2 claim
export { claimWithBootstrap, claimBatch } from "./l2/claim";
