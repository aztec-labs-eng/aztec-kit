import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type EIP1193Provider,
  type Hex,
  formatUnits,
  type Chain,
  type TransactionReceipt,
  parseAbi,
  decodeEventLog,
} from "viem";
import { sepolia, mainnet, foundry } from "viem/chains";
import { computeSecretHash } from "@aztec/aztec.js/crypto";
import { Fr } from "@aztec/foundation/curves/bn254";

// ── ABIs ─────────────────────────────────────────────────────────────

export const erc20ReadAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export const erc20WriteAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const handlerReadAbi = parseAbi(["function mintAmount() view returns (uint256)"]);

// ── Chain helpers ────────────────────────────────────────────────────

const CHAIN_MAP: Record<number, Chain> = {
  11155111: sepolia,
  1: mainnet,
  31337: foundry,
};

export function getChain(chainId: number): Chain {
  return CHAIN_MAP[chainId] ?? { ...sepolia, id: chainId, name: `Chain ${chainId}` };
}

// ── Hex helpers ──────────────────────────────────────────────────────

/** Converts a bigint to a 0x-prefixed, 64-char hex string. */
export function toHex64(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

// ── Viem workaround ──────────────────────────────────────────────────

// Workaround: viem 2.47 requires authorizationList in readContract types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const viemReadContract = (client: any, params: any) => client.readContract(params);

// ── Client factories ─────────────────────────────────────────────────

/**
 * Creates a public client that reads through the selected wallet's provider
 * if given, falling back to the configured RPC URL.
 */
export function getL1PublicClient(
  l1RpcUrl: string,
  chainId: number,
  provider?: EIP1193Provider | null,
) {
  const chain = getChain(chainId);
  if (provider) {
    return createPublicClient({ chain, transport: custom(provider) });
  }
  return createPublicClient({ chain, transport: http(l1RpcUrl) });
}

/**
 * Returns a { publicClient, walletClient, account, chain } bundle for L1 write
 * operations, bound to the selected wallet's provider.
 * Throws if no account is connected.
 */
export async function getL1Clients(provider: EIP1193Provider, chainId: number) {
  const chain = getChain(chainId);
  const publicClient = createPublicClient({ chain, transport: custom(provider) });
  const walletClient = createWalletClient({ chain, transport: custom(provider) });
  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error("No account connected");
  return { publicClient, walletClient, account, chain };
}

// ── ERC20 read helpers ───────────────────────────────────────────────

export async function getFeeJuiceBalance(
  l1RpcUrl: string,
  chainId: number,
  tokenAddress: Hex,
  account: Hex,
  provider?: EIP1193Provider | null,
): Promise<{ balance: bigint; formatted: string; decimals: number }> {
  const client = getL1PublicClient(l1RpcUrl, chainId, provider);
  const [balance, decimals] = await Promise.all([
    viemReadContract(client, {
      address: tokenAddress,
      abi: erc20ReadAbi,
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>,
    viemReadContract(client, {
      address: tokenAddress,
      abi: erc20ReadAbi,
      functionName: "decimals",
    }) as Promise<number>,
  ]);
  return { balance, formatted: formatUnits(balance, decimals), decimals };
}

export async function getMintAmount(
  l1RpcUrl: string,
  chainId: number,
  handlerAddress: Hex,
  provider?: EIP1193Provider | null,
): Promise<bigint> {
  const client = getL1PublicClient(l1RpcUrl, chainId, provider);
  return viemReadContract(client, {
    address: handlerAddress,
    abi: handlerReadAbi,
    functionName: "mintAmount",
  }) as Promise<bigint>;
}

// ── Claim secret generation ──────────────────────────────────────────

export async function generateClaimSecret(): Promise<{
  secret: bigint;
  secretHash: bigint;
}> {
  const secret = Fr.random();
  const secretHash = await computeSecretHash(secret);
  return { secret: secret.toBigInt(), secretHash: secretHash.toBigInt() };
}

// ── Event extraction ─────────────────────────────────────────────────

const depositEventAbi = parseAbi([
  "event DepositToAztecPublic(bytes32 indexed to, uint256 amount, bytes32 secretHash, bytes32 key, uint256 index)",
]);

type DepositEvent = {
  to: Hex;
  amount: bigint;
  secretHash: Hex;
  key: Hex;
  index: bigint;
};

export type { DepositEvent };

export function extractAllDepositEvents(receipt: TransactionReceipt): DepositEvent[] {
  const events: DepositEvent[] = [];
  for (const log of receipt.logs) {
    try {
      const raw = log as unknown as { data: Hex; topics: [Hex, ...Hex[]] };
      if (!raw.topics?.[0]) continue;
      const decoded = decodeEventLog({
        abi: depositEventAbi,
        data: raw.data,
        topics: raw.topics,
      }) as { args: DepositEvent };
      events.push(decoded.args);
    } catch {
      // Not a DepositToAztecPublic event — skip
    }
  }
  return events;
}

// ── Bridge contract address ──────────────────────────────────────────

/**
 * GoBridge is deployed at a deterministic CREATE2 address on every
 * chain, so the app just returns that address — no env var, no cache, no
 * auto-deploy. Operators are responsible for ensuring the contract exists
 * at that address on each network before first use (see `@aztec-kit/contracts-ethereum`).
 */
export { getBridgeAddress } from "@aztec-kit/contracts-ethereum";
