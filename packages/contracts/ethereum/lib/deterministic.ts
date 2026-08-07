import {
  createPublicClient,
  createWalletClient,
  getContractAddress,
  http,
  type Account,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, mainnet, sepolia } from "viem/chains";
import {
  BRIDGE_CONTRACT_BYTECODE,
  BRIDGE_CONTRACT_ABI,
} from "../generated/bridge-contract-artifacts.js";

/**
 * Arachnid deterministic-deployment-proxy — pre-deployed at the same address
 * on most chains, including Anvil. Calling it with `salt ++ initcode` deploys
 * via CREATE2, producing a fully-deterministic contract address.
 *
 * This is the single deployment path for GoBridge across every
 * environment. Because the address is a pure
 * function of the bytecode + salt, apps never need to plumb an address
 * through config — just call `getBridgeAddress()`.
 */
export const CREATE2_PROXY: Hex = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/** Salt used for every GoBridge deployment. */
export const BRIDGE_SALT: Hex = ("0x" + "00".repeat(32)) as Hex;

/** The deterministic address of GoBridge on every chain. */
export function getBridgeAddress(): Hex {
  return getContractAddress({
    opcode: "CREATE2",
    from: CREATE2_PROXY,
    salt: BRIDGE_SALT,
    bytecode: BRIDGE_CONTRACT_BYTECODE,
  });
}

/** Calldata accepted by the Arachnid proxy: `salt ++ initcode`. */
export function buildDeployCalldata(): Hex {
  return (BRIDGE_SALT + BRIDGE_CONTRACT_BYTECODE.slice(2)) as Hex;
}

/**
 * Deploys GoBridge via the CREATE2 proxy. Idempotent: if the bytecode
 * already lives at the deterministic address, this is a no-op and the existing
 * address is returned.
 */
export async function deployBridge(params: {
  rpcUrl: string;
  account: Account;
  chain: Chain;
}): Promise<Hex> {
  const address = getBridgeAddress();
  const publicClient = createPublicClient({
    chain: params.chain,
    transport: http(params.rpcUrl),
  });

  const existingCode = await publicClient.getCode({ address });
  if (existingCode && existingCode !== "0x") return address;

  const walletClient = createWalletClient({
    account: params.account,
    chain: params.chain,
    transport: http(params.rpcUrl),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hash = await (walletClient.sendTransaction as any)({
    to: CREATE2_PROXY,
    data: buildDeployCalldata(),
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return address;
}

// ── Named-chain convenience ──────────────────────────────────────────

/** Anvil's deterministic account #0 — NOT A SECRET. */
export const ANVIL_DEV_KEY: Hex =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export type ChainName = "sepolia" | "mainnet" | "anvil";

const CHAINS: Record<ChainName, { chain: Chain; defaultRpc: string }> = {
  sepolia: { chain: sepolia, defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com" },
  mainnet: { chain: mainnet, defaultRpc: "https://eth.drpc.org" },
  anvil: { chain: foundry, defaultRpc: "http://localhost:8545" },
};

export interface DeployL1BridgeParams {
  chainName: ChainName;
  /** Defaults to the chain's public RPC (anvil: `http://localhost:8545`). */
  rpcUrl?: string;
  /** Defaults to `ANVIL_DEV_KEY` for `anvil`; required for every other chain. */
  deployerKey?: Hex;
}

/**
 * Deploys (or reuses) the bridge on a named chain. Idempotent via CREATE2:
 * re-running returns the existing address without sending a new tx.
 */
export async function deployL1Bridge(params: DeployL1BridgeParams): Promise<Hex> {
  const entry = CHAINS[params.chainName];
  const key = params.deployerKey ?? (params.chainName === "anvil" ? ANVIL_DEV_KEY : undefined);
  if (!key) {
    throw new Error(`deployerKey is required for ${params.chainName}`);
  }
  return deployBridge({
    rpcUrl: params.rpcUrl ?? entry.defaultRpc,
    account: privateKeyToAccount(key),
    chain: entry.chain,
  });
}

// Re-export the generated ABI so a single import pulls everything a caller
// typically needs.
export { BRIDGE_CONTRACT_ABI, BRIDGE_CONTRACT_BYTECODE };
