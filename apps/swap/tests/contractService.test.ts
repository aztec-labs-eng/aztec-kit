import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeSponsoredSwap } from "../src/services/contractService";
import { hasSubscription } from "../src/services/subscriptionCache";

const { configId } = vi.hoisted(() => ({
  configId: { label: "config-id" },
}));

// Stable config_id for the on-chain fallback assertion.
vi.mock("@aztec/foundation/crypto/poseidon", () => ({
  poseidon2Hash: vi.fn(async () => configId),
}));

// Runtime wrapper is not exercised by these service tests.
vi.mock("@aztec-kit/contracts-aztec/subscription-fpc", () => ({
  SubscriptionFPC: {
    at: vi.fn(),
  },
}));

// In-memory localStorage shim (vitest runs in node, no DOM).
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
});

const FPC = "0xfpc";
const AMM = "0xamm";
const GO_COIN = "0xgo";
const GO_COIN_PREMIUM = "0xgop";
const USER = "0xuser";
const SELECTOR = "0xa539bd29";
const CONFIG_INDEX = 3;
const GAS_LIMITS = { daGas: 1, l2Gas: 2 };

// Minimal AztecAddress-like shim used by the service.
function address(value: string) {
  return {
    toString: () => value,
    toField: () => ({ label: `${value}:field` }),
    equals: (other: unknown) =>
      typeof other === "object" &&
      other != null &&
      "toString" in other &&
      (other as { toString: () => string }).toString() === value,
  };
}

describe("executeSponsoredSwap", () => {
  it("falls back to on-chain subscription state when the local cache misses", async () => {
    const userAddress = address(USER);
    const selector = {
      toString: () => SELECTOR,
      toField: () => ({ label: "selector-field" }),
    };
    const call = { selector };
    const receipt = { txHash: "sponsored" };

    const amm = {
      address: address(AMM),
      methods: {
        swap_tokens_for_exact_tokens_from: vi.fn(() => ({
          getFunctionCall: vi.fn(async () => call),
        })),
      },
    };
    const goCoin = { address: address(GO_COIN) };
    const goCoinPremium = { address: address(GO_COIN_PREMIUM) };

    // Helper spies distinguish subscribe vs sponsor path.
    const sponsor = vi.fn(async () => ({ receipt }));
    const subscribe = vi.fn(async () => ({ receipt: { txHash: "subscribed" } }));

    // FPC reports an existing subscription despite the empty local cache.
    const simulate = vi.fn(async () => ({ result: [true, 7n] }));
    const getSubscriptionInfo = vi.fn(() => ({ simulate }));
    const fpc = {
      address: address(FPC),
      helpers: { sponsor, subscribe },
      methods: {
        get_subscription_info: getSubscriptionInfo,
      },
    };
    // Only the subscribe path reads the node; this test takes the sponsor path.
    const node = {};
    const network = {
      subscriptionFPC: {
        address: FPC,
        functions: {
          [AMM]: {
            [SELECTOR]: {
              // Same selector/config lookup shape as NetworkConfig.
              configIndex: CONFIG_INDEX,
              gasLimits: GAS_LIMITS,
              hasPublicCall: false,
            },
          },
        },
      },
    };

    expect(hasSubscription(FPC, AMM, SELECTOR, CONFIG_INDEX, USER)).toBe(false);

    await expect(
      executeSponsoredSwap(
        node as never,
        network as never,
        amm as never,
        goCoin as never,
        goCoinPremium as never,
        fpc as never,
        userAddress as never,
        1,
        2,
      ),
    ).resolves.toBe(receipt);

    expect(getSubscriptionInfo).toHaveBeenCalledWith(userAddress, configId);
    expect(simulate).toHaveBeenCalledWith({ from: userAddress });
    expect(subscribe).not.toHaveBeenCalled();
    expect(sponsor).toHaveBeenCalledWith({
      call,
      configIndex: CONFIG_INDEX,
      userAddress,
      gasLimits: GAS_LIMITS,
      hasPublicCall: false,
    });
    expect(hasSubscription(FPC, AMM, SELECTOR, CONFIG_INDEX, USER)).toBe(true);
  });
});
