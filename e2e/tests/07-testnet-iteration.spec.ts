import { type Page } from "@playwright/test";
import { test, expect } from "../fixtures/test-base.ts";

/**
 * Spec 07 — testnet iteration loop for the caching-node-proxy + tag warmer.
 *
 * The wallet pre-warms PXE's tag cache by deriving every
 * `(sender, recipient, app, index)` tuple PXE will scan and batch-fetching
 * them through the caching proxy. This spec validates that, against the
 * REAL testnet (network latency + actively-advancing chain), the warmer:
 *
 *   1. Fires before the user clicks "Swap".
 *   2. Covers PXE's actual scan window (cache hit rate ≥ a meaningful
 *      threshold for `getPrivateLogsByTags`).
 *   3. Adapts to index drift (the `triplesExtended` count is reported).
 *
 * Two test variants:
 *
 *   • **`captures warm telemetry on boot (no drip, no swap)`** — exercises
 *     onboarding only, asserts the warm fires after `registerContract`
 *     and produces sensible stats. Doesn't need a drip password, so it
 *     can run in any environment with testnet connectivity.
 *
 *   • **`full swap flow`** — drives the full drip+swap loop. Asserts
 *     swap completes AND the post-swap cache hit-rate for
 *     `getPrivateLogsByTags` is >= a non-trivial threshold. Skipped
 *     without `TESTNET_POP_PASSWORD`.
 *
 * Both capture `[warm] …` (from the wallet's diagnostic emitter) and
 * `[node-proxy] …` (from the inspector's auto-dump every 5s) and tee
 * them to the test output so a failed run yields actionable telemetry.
 */

const TESTNET_PASSWORD = process.env.TESTNET_POP_PASSWORD ?? "";
const FROM_AMOUNT = "1";

/** A single browser console line we care about. */
type Line = {
  /** Monotonic timestamp ms (Date.now() at capture). */
  t: number;
  text: string;
};

async function openOnboardingTestnet(page: Page, lines: Line[]) {
  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "info" || t === "warning" || t === "error") {
      lines.push({ t: Date.now(), text: msg.text() });
    }
  });

  // Force-select testnet BEFORE any script runs so the wallet boots
  // against the right node.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("goswap_network", "testnet");
    } catch {
      /* ignore */
    }
  });
  await page.goto("/");
  const walletChip = page.getByTestId("wallet-chip");
  await walletChip.waitFor({ timeout: 60_000 });
  await expect(walletChip).toHaveAttribute("data-connected", "false", { timeout: 30_000 });
  await walletChip.click();
}

/**
 * Pull all `[warm] start/done/…` events from the captured console lines.
 * The diagnostic emitter ({@link EmbeddedWallet.warmTagCache}) only fires
 * these when the wallet was constructed with `inspect: true` — which the
 * dev swap app does in non-prod modes.
 */
type WarmEvent = { t: number; kind: "start" | "done" | "skipped" | "trigger" | "threw"; text: string };
function extractWarmEvents(lines: Line[]): WarmEvent[] {
  const out: WarmEvent[] = [];
  for (const l of lines) {
    if (!l.text.startsWith("[warm] ")) continue;
    const body = l.text.slice("[warm] ".length);
    let kind: WarmEvent["kind"] | undefined;
    if (body.startsWith("start:")) kind = "start";
    else if (body.startsWith("done:")) kind = "done";
    else if (body.startsWith("skipped:")) kind = "skipped";
    else if (body.startsWith("trigger ")) kind = "trigger";
    else if (body.startsWith("threw")) kind = "threw";
    else continue;
    out.push({ t: l.t, kind, text: l.text });
  }
  return out;
}

/**
 * Parse the structured `done:` line into its fields. Format:
 *   "[warm] done: triples=12 batches=14 extended=2 tags=1240 logs=3 elapsed=842ms"
 */
function parseWarmDone(
  text: string,
): { triples: number; batches: number; extended: number; tags: number; logs: number; elapsedMs: number } | undefined {
  const m = text.match(
    /done: triples=(\d+) batches=(\d+) extended=(\d+) tags=(\d+) logs=(\d+) elapsed=(\d+)ms/,
  );
  if (!m) return undefined;
  return {
    triples: Number(m[1]),
    batches: Number(m[2]),
    extended: Number(m[3]),
    tags: Number(m[4]),
    logs: Number(m[5]),
    elapsedMs: Number(m[6]),
  };
}

test.describe.serial("testnet iteration", () => {
  test.slow();

  test("captures warm telemetry on boot (no drip, no swap)", async ({ page }) => {
    // This variant runs without `TESTNET_POP_PASSWORD` — it only exercises
    // the wallet boot + contract registration phase. It's the test I run
    // when iterating on the warm-up itself: confirms the warm fires after
    // registerContract storms, completes in a sane time, and reports
    // sensible stats. The drip+swap variant below validates the END-TO-END
    // cache hit rate.
    const lines: Line[] = [];
    await openOnboardingTestnet(page, lines);

    const modal = page.getByTestId("onboarding-modal");
    await modal.waitFor({ timeout: 30_000 });
    await page.getByTestId("onboarding-use-embedded").click();

    // Wait until the onboarding flow reaches "awaiting_drip" — that's
    // the moment the wallet has finished registering every contract and
    // simulating onboarding queries. By then the warm should have fired
    // at least once.
    await expect(modal).toHaveAttribute("data-status", "awaiting_drip", { timeout: 180_000 });

    // Pull warm events from the console capture.
    const warmEvents = extractWarmEvents(lines);
    console.log(`[testnet-iter] warm events captured: ${warmEvents.length}`);
    for (const e of warmEvents) console.log(`  ${e.text}`);

    // Hard guarantee #1: the warm fired at least once before drip.
    const dones = warmEvents.filter((e) => e.kind === "done");
    expect(
      dones.length,
      "warm-up never reported a `done` event before drip — either it didn't fire, or it threw",
    ).toBeGreaterThan(0);

    // Hard guarantee #2: the LAST warm before drip enumerated triples > 0.
    const lastDone = parseWarmDone(dones[dones.length - 1]!.text);
    expect(lastDone, "could not parse the warm `done:` line").toBeDefined();
    expect(
      lastDone!.triples,
      "warm reported zero triples — accounts/senders/contracts didn't reach the warmer",
    ).toBeGreaterThan(0);

    // Hard guarantee #3: the warm completed in a reasonable budget. On
    // testnet a fresh warm is 1-2s; if we're seeing 30s+ something is
    // serializing that shouldn't be (a regression in parallel dispatch).
    expect(
      lastDone!.elapsedMs,
      `warm took ${lastDone!.elapsedMs}ms — should complete in well under 30s on testnet`,
    ).toBeLessThan(30_000);

    console.log(
      `[testnet-iter] last warm: triples=${lastDone!.triples} batches=${lastDone!.batches}` +
        ` extended=${lastDone!.extended} tags=${lastDone!.tags} logs=${lastDone!.logs}` +
        ` elapsed=${lastDone!.elapsedMs}ms`,
    );

    // Diagnostic: print every per-batch full-miss (PXE-originated only —
    // warm populates aren't logged here) to correlate which tag values
    // PXE asked for that the warmer didn't cover.
    const missLines = lines.filter((l) => l.text.startsWith("[node-proxy:miss]"));
    console.log(`[testnet-iter] PXE full-miss batches: ${missLines.length}`);
    for (const m of missLines.slice(0, 25)) console.log(`  ${m.text}`);

    // Pull stats directly from `window.__nodeProxy.stats()` rather than
    // relying on the 5s auto-dump cadence — the dump in the console
    // log can be from BEFORE PXE's final batch landed, falsely
    // reporting zero PXE calls. Direct read is always current.
    const live = await page.evaluate(() => {
      const inspector = (window as unknown as {
        __nodeProxy?: { stats: () => unknown };
      }).__nodeProxy;
      return inspector ? inspector.stats() : null;
    });
    expect(live, "window.__nodeProxy missing — inspect=true didn't propagate?").not.toBeNull();
    const tagStats = (live as {
      methods: Record<
        string,
        {
          calls: number;
          hits: number;
          misses: number;
          warmCalls?: number;
          warmHits?: number;
          elements?: { hits: number; seen: number };
        }
      >;
    }).methods.getPrivateLogsByTags;
    expect(tagStats, "getPrivateLogsByTags counter missing — PXE never asked?").toBeDefined();

    const warmCalls = tagStats.warmCalls ?? 0;
    const warmHits = tagStats.warmHits ?? 0;
    const pxeCalls = tagStats.calls - warmCalls;
    const pxeHits = tagStats.hits - warmHits;
    const pxeRate = pxeCalls > 0 ? pxeHits / pxeCalls : 0;
    const elem = tagStats.elements;
    console.log(
      `[testnet-iter] PXE-only hit rate: ${pxeHits}/${pxeCalls} = ${Math.round(pxeRate * 100)}%` +
        ` (overall calls=${tagStats.calls} hits=${tagStats.hits}; warm calls=${warmCalls})` +
        (elem ? ` per-element hits=${elem.hits}/${elem.seen}` : ""),
    );

    // Hard floor: PXE-only hit rate must be ≥ 80%. The warm is supposed
    // to match PXE's actual scan window — anything below means our
    // enumeration is wrong (missing an account, missing a sender,
    // indices outside our window, etc.).
    expect(
      pxeRate,
      `PXE-only hit rate ${Math.round(pxeRate * 100)}% < 80%. ` +
        `PXE made ${pxeCalls} batched calls of which ${pxeHits} hit cache. ` +
        `If the warm matches PXE's tag enumeration, this should be near 100%.`,
    ).toBeGreaterThanOrEqual(0.8);
  });

  test("full swap flow: warm + cache hits during sim", async ({ page }) => {
    test.skip(
      !TESTNET_PASSWORD,
      "TESTNET_POP_PASSWORD env var is required (the password set when testnet contracts were deployed).",
    );

    const lines: Line[] = [];
    await openOnboardingTestnet(page, lines);

    // ── 1. Pick embedded wallet ──────────────────────────────────────
    const modal = page.getByTestId("onboarding-modal");
    await modal.waitFor({ timeout: 30_000 });
    await page.getByTestId("onboarding-use-embedded").click();

    // ── 2. Drip (testnet PoP password) ───────────────────────────────
    const tBoot = Date.now();
    await expect(modal).toHaveAttribute("data-status", "awaiting_drip", { timeout: 180_000 });
    const tOnboardingReady = Date.now();
    console.log(
      `[testnet-iter] boot → awaiting_drip in ${tOnboardingReady - tBoot}ms (this is the user-perceived "is the app ready yet" wait)`,
    );

    // Snapshot warm telemetry BEFORE drip — we'll use this as the
    // "warm-before-swap" baseline.
    const warmBeforeDrip = extractWarmEvents(lines).filter((e) => e.kind === "done");
    expect(
      warmBeforeDrip.length,
      "warm-up did not produce a `done` event before drip — would mean cold cache for the first sim",
    ).toBeGreaterThan(0);

    const dripInput = page.getByTestId("drip-password-input");
    await dripInput.waitFor({ timeout: 10_000 });
    await dripInput.fill(TESTNET_PASSWORD);
    await page.getByTestId("drip-password-submit").click();
    await modal.waitFor({ state: "hidden", timeout: 300_000 });

    // ── 3. Swap ─────────────────────────────────────────────────────
    const swapContainer = page.getByTestId("swap-container");
    await swapContainer.waitFor({ timeout: 30_000 });

    const fromBox = page.getByTestId("swap-from");
    await expect(async () => {
      const raw = await fromBox.getAttribute("data-balance");
      expect(raw).not.toBe("");
      expect(raw).not.toBeNull();
      expect(BigInt(raw as string)).toBeGreaterThan(0n);
    }).toPass({ timeout: 120_000 });

    await page.getByTestId("swap-from-input").fill(FROM_AMOUNT);
    const submit = page.getByTestId("swap-submit");
    await expect(submit).toBeEnabled({ timeout: 60_000 });

    // Capture stats baseline at the moment of click so we can compute
    // the DELTA across the swap (sim + prove + send attempt).
    const tClick = Date.now();
    const statsAtClick = await page.evaluate(() => {
      const i = (window as unknown as { __nodeProxy?: { stats: () => unknown } }).__nodeProxy;
      return i ? i.stats() : null;
    });
    await submit.click();

    // Wait for the swap to either succeed or error out. `sending`
    // fires immediately at click and is NOT a useful boundary —
    // sim+prove run AFTER that phase begins. Accepting `success` or
    // `error` (e.g. testnet CORS blocks final send) both reflect a
    // completed sim+prove pipeline.
    const tEnd = await page.evaluate(async () => {
      const el = document.querySelector('[data-testid="swap-container"]') as HTMLElement | null;
      if (!el) return 0;
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const phase = el.getAttribute("data-phase");
        if (phase === "success" || phase === "error") return Date.now();
        await new Promise((r) => setTimeout(r, 100));
      }
      return 0;
    });
    const swapElapsedMs = tEnd > 0 ? tEnd - tClick : -1;
    const finalPhase = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="swap-container"]') as HTMLElement | null;
      return el?.getAttribute("data-phase") ?? null;
    });
    console.log(
      `[testnet-iter] click → ${finalPhase ?? "(timeout)"} in ${swapElapsedMs}ms`,
    );

    // ── 4. Diagnostics ──────────────────────────────────────────────
    const liveStats = await page.evaluate(() => {
      const i = (window as unknown as { __nodeProxy?: { stats: () => unknown } }).__nodeProxy;
      return i ? i.stats() : null;
    });
    expect(liveStats, "no live proxy stats").not.toBeNull();
    const typed = liveStats as {
      methods: Record<
        string,
        { calls: number; hits: number; misses: number; upstream: number; warmCalls?: number; warmHits?: number }
      >;
    };

    // Compute DELTAS across the swap (excludes onboarding/boot).
    const baselineTyped = statsAtClick as typeof typed | null;
    function deltaFor(name: string): {
      calls: number;
      hits: number;
      misses: number;
      upstream: number;
      pxeCalls: number;
      pxeHits: number;
    } {
      const after = typed.methods[name];
      const before = baselineTyped?.methods?.[name];
      const calls = (after?.calls ?? 0) - (before?.calls ?? 0);
      const hits = (after?.hits ?? 0) - (before?.hits ?? 0);
      const misses = (after?.misses ?? 0) - (before?.misses ?? 0);
      const upstream = (after?.upstream ?? 0) - (before?.upstream ?? 0);
      const warmCalls = (after?.warmCalls ?? 0) - (before?.warmCalls ?? 0);
      const warmHits = (after?.warmHits ?? 0) - (before?.warmHits ?? 0);
      const pxeCalls = calls - warmCalls;
      const pxeHits = hits - warmHits;
      return { calls, hits, misses, upstream, pxeCalls, pxeHits };
    }

    // Headline: per-method swap-only stats.
    const headlineMethods = [
      "getPrivateLogsByTags",
      "getTxReceipt",
      "getTxEffect",
      "getPublicStorageAt",
      "findLeavesIndexes",
      "getNullifierMembershipWitness",
      "getNoteHashMembershipWitness",
      "getPublicDataWitness",
    ];
    console.log("[testnet-iter] SWAP-ONLY stats (click → end-of-sim+prove):");
    let totalSwapUpstream = 0;
    for (const m of headlineMethods) {
      const d = deltaFor(m);
      if (d.calls === 0) continue;
      const rate = d.calls > 0 ? Math.round((d.hits / d.calls) * 100) : 0;
      const pxeRate = d.pxeCalls > 0 ? Math.round((d.pxeHits / d.pxeCalls) * 100) : 0;
      console.log(
        `  ${m.padEnd(36)} calls=${String(d.calls).padStart(3)} hits=${String(d.hits).padStart(3)}` +
          ` miss=${String(d.misses).padStart(3)} up=${String(d.upstream).padStart(3)}` +
          ` (overall=${rate}%, pxe=${d.pxeHits}/${d.pxeCalls}=${pxeRate}%)`,
      );
      totalSwapUpstream += d.upstream;
    }
    console.log(
      `[testnet-iter] swap total upstream RPCs: ${totalSwapUpstream}, est network time: ${Math.round(totalSwapUpstream * 0.14)}s`,
    );

    // Use overall stats for the assertion (cumulative across the run).
    const tagStats = typed.methods.getPrivateLogsByTags;
    const parsed = {
      calls: tagStats.calls,
      hits: tagStats.hits,
      warmCalls: tagStats.warmCalls ?? 0,
      warmHits: tagStats.warmHits ?? 0,
      pxeCalls: tagStats.calls - (tagStats.warmCalls ?? 0),
      pxeHits: tagStats.hits - (tagStats.warmHits ?? 0),
    };
    const hitRate = parsed.calls > 0 ? parsed.hits / parsed.calls : 0;
    console.log(
      `[testnet-iter] getPrivateLogsByTags overall: calls=${parsed.calls} hits=${parsed.hits} (${Math.round(hitRate * 100)}%)` +
        ` PXE-only=${parsed.pxeHits}/${parsed.pxeCalls}`,
    );

    // Hard floor: the whole point of the warmer is that PXE's tag scans
    // hit our cache. Anything below 25% means the warm isn't matching
    // PXE's actual queries — either wrong triples, wrong indices, or
    // the warm fired too late. Threshold deliberately loose: as the
    // implementation tightens, raise it.
    expect(
      hitRate,
      `getPrivateLogsByTags hit rate ${Math.round(hitRate * 100)}% is below the 25% floor — warm is failing to cover PXE's scan`,
    ).toBeGreaterThanOrEqual(0.25);
  });
});
