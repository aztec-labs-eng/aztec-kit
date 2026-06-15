/**
 * Thin argv parsers shared by deploy scripts. All exit the process on invalid
 * input — scripts can assume a valid return value.
 */
import {
  VALID_NETWORKS,
  VALID_PAYMENT_MODES,
  DEFAULT_PAYMENT_MODE,
  type NetworkName,
  type PaymentMode,
} from "./network-config.ts";

export function parseNetwork(): NetworkName {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--network");
  if (idx === -1 || idx === args.length - 1) {
    console.error(`Usage: ... --network <${VALID_NETWORKS.join("|")}>`);
    process.exit(1);
  }
  const network = args[idx + 1];
  if (!VALID_NETWORKS.includes(network as NetworkName)) {
    console.error(`Invalid network: ${network}. Must be one of: ${VALID_NETWORKS.join(", ")}`);
    process.exit(1);
  }
  return network as NetworkName;
}

/**
 * Parses `--payment <feejuice|sponsoredfpc>` from argv, falling back to the
 * per-network default in `DEFAULT_PAYMENT_MODE`.
 */
export function parsePaymentMode(network: NetworkName): PaymentMode {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--payment");
  if (idx === -1 || idx === args.length - 1) return DEFAULT_PAYMENT_MODE[network];
  const mode = args[idx + 1];
  if (!VALID_PAYMENT_MODES.includes(mode as PaymentMode)) {
    console.error(
      `Invalid --payment mode: ${mode}. Must be one of: ${VALID_PAYMENT_MODES.join(", ")}`,
    );
    process.exit(1);
  }
  return mode as PaymentMode;
}

/**
 * Collects repeated `--flag <value>` occurrences plus an optional comma-
 * separated env-var list into a single array. Used by `mint.ts` etc.
 */
export function parseAddressList(flag: string, envVar?: string): string[] {
  const args = process.argv.slice(2);
  const addresses: string[] = [];
  let i = 0;
  while (i < args.length) {
    if (args[i] === flag && i + 1 < args.length) {
      addresses.push(args[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }
  if (envVar && process.env[envVar]) {
    addresses.push(
      ...process.env[envVar]!.split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  return addresses;
}
