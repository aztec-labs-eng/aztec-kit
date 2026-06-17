/**
 * Swap's per-network config is richer than bridge/fpc-operator — each JSON
 * also carries the addresses of the deployed contracts + the SubscriptionFPC
 * config. Loaded via glob so adding a new network is just dropping in a new
 * JSON.
 *
 * Network presence is a *build concern*: production deploys delete
 * `local.json` before building, so the bundle only carries real networks.
 * Local dev / e2e leave `local.json` in place and it becomes the default.
 */

/**
 * Per-function sponsorship record. `gasLimits` is the sponsored fn's own
 * gas (no FPC overhead) — the subscribe/sponsor helpers add the
 * appropriate FPC overhead on top at call time. Measured at calibration
 * and committed alongside the slot's `max_fee`.
 *
 * `hasPublicCall` reflects whether the sponsored call enqueues a public
 * phase. A private-typed fn can still enqueue public work (e.g. PoP's
 * mint via the Token contract); when it does, the tx is priced under
 * the public regime and the FPC's own private ops get repriced at AVM
 * rates, so the subscribe/sponsor helpers must pick the PUBLIC overhead
 * constant. Detected at calibration.
 */
export interface SubscriptionFunctionConfig {
  configIndex: number;
  gasLimits: { daGas: number; l2Gas: number };
  hasPublicCall: boolean;
}

export interface SubscriptionFPCConfig {
  /** Address of the SubscriptionFPC contract */
  address: string;
  /** Secret key for registering the FPC in PXE (needed to decrypt slot notes) */
  secretKey: string;
  /** Map of contractAddress → { functionSelector → per-function config } */
  functions: Record<string, Record<string, SubscriptionFunctionConfig>>;
}

export interface NetworkConfig {
  id: string;
  nodeUrl: string;
  /**
   * Optional API key for a gateway-fronted node. In the JSON it's a
   * build-time placeholder `${VITE_<NETWORK>_API_KEY}`, resolved below.
   */
  apiKey?: string;
  chainId: string;
  rollupVersion: string;
  contracts: {
    goCoin: string;
    goCoinPremium: string;
    amm: string;
    liquidityToken: string;
    pop: string;
    sponsoredFPC: string;
    salt: string;
  };
  deployer: { address: string };
  deployedAt: string;
  /** Subscription-based FPC for sponsored transactions (operator-managed) */
  subscriptionFPC?: SubscriptionFPCConfig;
}

const modules = import.meta.glob<{ default: NetworkConfig }>("./*.json", { eager: true });

/** Resolve `${VITE_*}` placeholders in config strings from build-time env. */
function resolveEnvPlaceholders<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(
      /\$\{(\w+)\}/g,
      (_, k) => (import.meta.env as Record<string, string | undefined>)[k] ?? "",
    ) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveEnvPlaceholders(v)]),
    ) as T;
  }
  return value;
}

/**
 * Order of preference: local first (if present), then testnet, then anything
 * else alphabetically. `getDefaultNetwork` returns `NETWORKS[0]`, so this
 * ordering is what picks the default network on first load.
 */
const PREFERRED_ORDER = ["local", "testnet"];

const NETWORKS: NetworkConfig[] = Object.values(modules)
  .map((m) => resolveEnvPlaceholders(m.default))
  .filter((n): n is NetworkConfig => !!n && typeof n.id === "string")
  .sort((a, b) => {
    const ai = PREFERRED_ORDER.indexOf(a.id);
    const bi = PREFERRED_ORDER.indexOf(b.id);
    const aw = ai === -1 ? PREFERRED_ORDER.length : ai;
    const bw = bi === -1 ? PREFERRED_ORDER.length : bi;
    return aw - bw || a.id.localeCompare(b.id);
  });

export function getNetworks(): NetworkConfig[] {
  return NETWORKS;
}

export function getDefaultNetwork(): NetworkConfig {
  if (NETWORKS.length === 0) {
    throw new Error(
      'No network configurations found. Run "yarn deploy:local" / "yarn deploy:testnet" first.',
    );
  }
  return NETWORKS[0];
}

/** @deprecated Use `getNetworks` directly. */
export function initializeNetworks(): NetworkConfig[] {
  return getNetworks();
}

export function getNetworkById(networks: NetworkConfig[], id: string): NetworkConfig | undefined {
  return networks.find((n) => n.id === id);
}
