import { createPublicClient, http, parseUnits, formatUnits, type Chain } from "viem";
import { sepolia, mainnet } from "viem/chains";
import { RollupAbi } from "@aztec/l1-artifacts/RollupAbi";

const CHAIN_MAP: Record<number, { chain: Chain; defaultRpc: string }> = {
  1: { chain: mainnet, defaultRpc: "https://eth.llamarpc.com" },
  11155111: {
    chain: sepolia,
    defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com",
  },
};

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedValue<T> {
  value: T;
  fetchedAt: number;
}

type L1Client = ReturnType<typeof createPublicClient>;

/**
 * Converts Aztec fee juice amounts to ETH and USD.
 * Reads the ETH/FeeAsset exchange rate from the Rollup L1 contract
 * and the ETH/USD price from CoinGecko.
 */
export class FeePricingService {
  private client: L1Client | null = null;
  private rollupAddress: `0x${string}` | null = null;
  private ethPerFeeAssetCache: CachedValue<bigint> | null = null;
  private ethUsdCache: CachedValue<number> | null = null;

  constructor(
    private readonly l1RpcUrl: string | undefined,
    private readonly l1ChainId: number | undefined,
  ) {}

  init(rollupAddress: string) {
    if (!this.l1ChainId) return;
    const entry = CHAIN_MAP[this.l1ChainId];
    if (!entry) return;
    const rpcUrl = this.l1RpcUrl ?? entry.defaultRpc;
    this.rollupAddress = rollupAddress as `0x${string}`;
    this.client = createPublicClient({
      chain: entry.chain,
      transport: http(rpcUrl),
    });
  }

  get enabled(): boolean {
    return this.client !== null && this.rollupAddress !== null;
  }

  private async getEthPerFeeAssetE12(): Promise<bigint | null> {
    if (!this.client || !this.rollupAddress) return null;
    if (
      this.ethPerFeeAssetCache &&
      Date.now() - this.ethPerFeeAssetCache.fetchedAt < CACHE_TTL_MS
    ) {
      return this.ethPerFeeAssetCache.value;
    }
    try {
      // viem's typed `readContract` wants a narrower abi/function union; the
      // cast-through-unknown keeps this helper abi-agnostic.
      const value = await (
        this.client as unknown as {
          readContract: (args: unknown) => Promise<unknown>;
        }
      ).readContract({
        address: this.rollupAddress,
        abi: RollupAbi,
        functionName: "getEthPerFeeAsset",
      });
      this.ethPerFeeAssetCache = {
        value: value as bigint,
        fetchedAt: Date.now(),
      };
      return value as bigint;
    } catch {
      return this.ethPerFeeAssetCache?.value ?? null;
    }
  }

  private async getEthUsdPrice(): Promise<number | null> {
    if (this.ethUsdCache && Date.now() - this.ethUsdCache.fetchedAt < CACHE_TTL_MS) {
      return this.ethUsdCache.value;
    }
    try {
      const res = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      );
      if (!res.ok) return this.ethUsdCache?.value ?? null;
      const data = (await res.json()) as { ethereum?: { usd?: number } };
      const price = data.ethereum?.usd;
      if (price == null) return this.ethUsdCache?.value ?? null;
      this.ethUsdCache = { value: price, fetchedAt: Date.now() };
      return price;
    } catch {
      return this.ethUsdCache?.value ?? null;
    }
  }

  async getPricing(): Promise<{
    ethUsdPrice: number;
    ethPerFeeAssetE12: string;
  } | null> {
    if (!this.enabled) return null;
    const [ethPerFeeAssetE12, ethUsdPrice] = await Promise.all([
      this.getEthPerFeeAssetE12(),
      this.getEthUsdPrice(),
    ]);
    if (ethPerFeeAssetE12 == null || ethUsdPrice == null) return null;
    return { ethUsdPrice, ethPerFeeAssetE12: ethPerFeeAssetE12.toString() };
  }

  /**
   * Estimate the USD cost of a given fee amount (in raw FJ units).
   *
   * Math:
   *   costEthWei = feeRaw * ethPerFeeAssetE12 / 1e12
   *   costEth    = costEthWei / 1e18
   *   costUsd    = costEth * ethUsdPrice
   */
  async estimateCostUsd(feeRaw: bigint): Promise<{
    costUsd: number;
    costEth: number;
    costFj: number;
    ethUsdPrice: number;
  } | null> {
    if (!this.enabled || feeRaw === 0n) return null;
    const [ethPerFeeAssetE12, ethUsdPrice] = await Promise.all([
      this.getEthPerFeeAssetE12(),
      this.getEthUsdPrice(),
    ]);
    if (ethPerFeeAssetE12 == null || ethUsdPrice == null) return null;

    const costEthWei = (feeRaw * ethPerFeeAssetE12) / BigInt(1e12);
    const costEth = Number(costEthWei) / 1e18;
    const costFj = Number(feeRaw) / 1e18;
    const costUsd = costEth * ethUsdPrice;

    return { costUsd, costEth, costFj, ethUsdPrice };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Convert human-readable FJ (e.g. "1.7") to raw bigint */
export function fjToRaw(fj: string): bigint {
  return parseUnits(fj, 18);
}

/** Convert raw bigint to human-readable FJ */
export function rawToFj(raw: bigint): string {
  return formatUnits(raw, 18);
}
