/**
 * InflightDedup unit tests.
 *
 * Dedup is a performance optimization, but a buggy dedup could return the
 * wrong response (e.g. share a promise across distinct keys). Verifying
 * the key invariants.
 */

import { describe, expect, it } from "vitest";

import { InflightDedup } from "../../src/node-proxy/inflight";

describe("InflightDedup", () => {
  it("concurrent identical keys share a single promise", async () => {
    const d = new InflightDedup<string, number>();
    let calls = 0;
    const work = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    };
    const [a, b, c] = await Promise.all([
      d.run("k", work),
      d.run("k", work),
      d.run("k", work),
    ]);
    expect(a).toBe(42);
    expect(b).toBe(42);
    expect(c).toBe(42);
    expect(calls).toBe(1);
  });

  it("different keys do NOT share a promise", async () => {
    const d = new InflightDedup<string, number>();
    let calls = 0;
    const work = async (n: number) => {
      calls++;
      return n;
    };
    const [a, b] = await Promise.all([d.run("k1", () => work(1)), d.run("k2", () => work(2))]);
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(calls).toBe(2);
  });

  it("releases the slot after fulfillment so retries are independent", async () => {
    const d = new InflightDedup<string, number>();
    let calls = 0;
    const work = async () => {
      calls++;
      return calls; // each call returns a fresh number
    };
    const first = await d.run("k", work);
    const second = await d.run("k", work);
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect(d.size()).toBe(0);
  });

  it("releases the slot after rejection so retries are independent", async () => {
    const d = new InflightDedup<string, number>();
    let calls = 0;
    await expect(
      d.run("k", async () => {
        calls++;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Slot is free — a second call calls fn again.
    await expect(
      d.run("k", async () => {
        calls++;
        throw new Error("boom2");
      }),
    ).rejects.toThrow("boom2");
    expect(calls).toBe(2);
    expect(d.size()).toBe(0);
  });
});
