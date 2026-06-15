/**
 * Network configs are per-file under this directory. A network appears in
 * the UI if its JSON exists at build time — `import.meta.glob` + `eager`
 * fixes the set when the bundle is produced.
 *
 * Network presence is a *build concern*: production deploys delete
 * `local.json` before building, so the bundle only carries real networks.
 * Local dev / e2e leave `local.json` in place and it becomes the default.
 */

export interface NetworkConfig {
  id: string;
  name: string;
  aztecNodeUrl: string;
  /**
   * Optional API key for a gateway-fronted node. In the JSON it's a
   * build-time placeholder `${VITE_<NETWORK>_API_KEY}`, resolved below.
   */
  apiKey?: string;
  l1RpcUrl: string;
  l1ChainId: number;
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

/** Preference order; unknown ids sort alphabetically at the end. */
const PREFERRED_ORDER = ["local", "staging", "testnet"];

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
      "No network configs found under src/config/networks/. Check at least one JSON exists.",
    );
  }
  return NETWORKS[0];
}
