import { describe, it, expect, beforeEach } from "vitest";
import {
  hasSubscription,
  markSubscribed,
  subscriptionKey,
} from "../src/services/subscriptionCache";

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
const USER = "0xuser";
const IDX = 3; // all swap-app signups share one configIndex

// The two apps/selectors a real session hits back-to-back: an AMM swap, then a
// token transfer. They share `configIndex`, so a key that omits app+selector
// treats the transfer as already-subscribed after the swap.
const AMM = "0xamm";
const AMM_SWAP_SEL = "0xa539bd29";
const TOKEN = "0xtoken";
const TOKEN_TRANSFER_SEL = "0xb27dc0cb";

describe("subscription cache key", () => {
  it("distinguishes selectors that share (fpc, configIndex, user)", () => {
    expect(subscriptionKey(FPC, AMM, AMM_SWAP_SEL, IDX, USER)).not.toBe(
      subscriptionKey(FPC, TOKEN, TOKEN_TRANSFER_SEL, IDX, USER),
    );
  });

  it("subscribing to the swap does not mark the token transfer subscribed", () => {
    // First sponsored action: subscribe to the AMM swap.
    markSubscribed(FPC, AMM, AMM_SWAP_SEL, IDX, USER);

    // The token transfer shares (fpc, configIndex, user) but is a different
    // (app, selector) — it must still be unsubscribed, so the send subscribes
    // instead of calling sponsor() against a config_id that has no note.
    expect(hasSubscription(FPC, TOKEN, TOKEN_TRANSFER_SEL, IDX, USER)).toBe(false);

    // Sanity: the swap itself is now subscribed.
    expect(hasSubscription(FPC, AMM, AMM_SWAP_SEL, IDX, USER)).toBe(true);
  });

  it("round-trips a single (app, selector) subscription", () => {
    expect(hasSubscription(FPC, TOKEN, TOKEN_TRANSFER_SEL, IDX, USER)).toBe(false);
    markSubscribed(FPC, TOKEN, TOKEN_TRANSFER_SEL, IDX, USER);
    expect(hasSubscription(FPC, TOKEN, TOKEN_TRANSFER_SEL, IDX, USER)).toBe(true);
  });
});
