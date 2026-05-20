/**
 * Network + payment-mode constants shared by every deploy script.
 * Node-only — scripts pass these to `@aztec/aztec.js/ethereum` clients.
 */

export const VALID_NETWORKS = ["local", "testnet", "nextnet"] as const;
export type NetworkName = (typeof VALID_NETWORKS)[number];

export const NETWORK_URLS: Record<NetworkName, string> = {
  local: "http://localhost:8080",
  testnet: "https://rpc.testnet.aztec-labs.com",
  nextnet: "https://nextnet.aztec-labs.com",
};

/** L1 parameters the bridging scripts need. Keep in sync with the rollup. */
export const L1_DEFAULTS: Record<NetworkName, { l1RpcUrl: string; l1ChainId: number }> = {
  local: { l1RpcUrl: "http://localhost:8545", l1ChainId: 31337 },
  testnet: { l1RpcUrl: "https://sepolia.drpc.org", l1ChainId: 11155111 },
  nextnet: { l1RpcUrl: "https://sepolia.drpc.org", l1ChainId: 11155111 },
};

/**
 * Anvil's first pre-funded dev key — used only for `local`. Published and
 * non-secret; lets CI + dev loops work with zero configuration.
 */
export const LOCAL_L1_FUNDER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

/**
 * Picks the L1 funder key for the target network. `bridgeFeeJuice` itself
 * decides whether to mint via the faucet based on the signer's FJ balance —
 * this helper just chooses which key signs the tx.
 *
 *   L1_FUNDER_KEY env set → use it.
 *   local, env unset      → anvil's first dev key (has ETH for gas).
 *   testnet, env unset    → undefined (bridgeFeeJuice generates a random key).
 */
export function resolveL1Funder(network: NetworkName): `0x${string}` | undefined {
  const env = process.env.L1_FUNDER_KEY as `0x${string}` | undefined;
  if (env) return env;
  if (network === "local") return LOCAL_L1_FUNDER_KEY as `0x${string}`;
  return undefined;
}

/**
 * `local` can cheat-warp L1+L2 time to force the L1→L2 message through;
 * every other network just polls for inclusion.
 */
export function bridgeMode(network: NetworkName): "warp" | "poll" {
  return network === "local" ? "warp" : "poll";
}

export const VALID_PAYMENT_MODES = ["feejuice", "sponsoredfpc"] as const;
export type PaymentMode = (typeof VALID_PAYMENT_MODES)[number];

/** Default payment mode per network if `--payment` is omitted. */
export const DEFAULT_PAYMENT_MODE: Record<NetworkName, PaymentMode> = {
  local: "sponsoredfpc",
  testnet: "feejuice",
  nextnet: "feejuice",
};
