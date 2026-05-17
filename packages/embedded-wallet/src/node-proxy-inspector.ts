/**
 * Dev-only inspector for the caching node proxy. When registered, exposes
 * `window.__nodeProxy` so cache hit/miss/upstream counters can be inspected
 * from DevTools, and prints a periodic summary so cache effectiveness is
 * visible in any run without manual probing.
 */

import type { CachingNodeProxy, CacheStats } from "./node-proxy";

type Inspectors = {
  /** Snapshot of cache + per-method counters. */
  stats(): CacheStats;
  /** Print a one-shot summary to the console. */
  dump(): void;
  /** Capture a new counter baseline (the cache itself is NOT cleared). */
  reset(): void;
  /** Internal: direct access to the proxy. */
  proxy: CachingNodeProxy;
};

function formatTable(stats: CacheStats): string {
  const rows: string[] = [];
  const methods = Object.entries(stats.methods).sort((a, b) => b[1].calls - a[1].calls);
  for (const [name, c] of methods) {
    const hitRate = c.calls > 0 ? ((c.hits / c.calls) * 100).toFixed(0) + "%" : "-";
    const elem = c.elements ? ` el=${c.elements.hits}/${c.elements.seen}` : "";
    // PXE-only hit rate: subtracts warm-originated calls from the
    // denominator. This is the metric that actually matters for sim
    // latency; warm populate-calls are by construction misses and
    // would otherwise drag the headline number down.
    const warmCalls = c.warmCalls ?? 0;
    const warmHits = c.warmHits ?? 0;
    const pxeCalls = c.calls - warmCalls;
    const pxeHits = c.hits - warmHits;
    const pxeRate =
      pxeCalls > 0 ? ((pxeHits / pxeCalls) * 100).toFixed(0) + "%" : "-";
    const warmTag =
      warmCalls > 0
        ? ` warm=${warmCalls} pxeHit=${pxeHits}/${pxeCalls}=${pxeRate}`
        : "";
    rows.push(
      `  ${name.padEnd(36)} calls=${String(c.calls).padStart(4)} ` +
        `hits=${String(c.hits).padStart(4)} miss=${String(c.misses).padStart(4)} ` +
        `up=${String(c.upstream).padStart(4)} hitRate=${hitRate.padStart(4)}${elem}${warmTag}`,
    );
  }
  const tip = stats.proposed
    ? `${stats.proposed.number}/${stats.proposed.hash.slice(0, 8)}…`
    : "—";
  const fin = stats.finalizedAt ?? "—";
  const prov = stats.provenAt ?? "—";
  return [
    `[node-proxy] tip(proposed)=${tip} finalized=${fin} proven=${prov} ring=${stats.ringSize}`,
    `[node-proxy] cache: permanent=${stats.permanent} speculative=${stats.speculative} tagLogBB=${stats.tagLogBlockBounded} leafIdxBB=${stats.leafIndexBlockBounded}`,
    rows.length > 0 ? `[node-proxy] per-method (calls desc):\n${rows.join("\n")}` : `[node-proxy] no calls yet`,
  ].join("\n");
}

export function registerNodeProxyInspector(
  proxy: CachingNodeProxy,
  options: { autoDumpMs?: number } = {},
): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  const baseline = JSON.parse(JSON.stringify(proxy.stats())) as CacheStats;
  const inspectors: Inspectors = {
    stats: () => proxy.stats(),
    dump: () => console.info(formatTable(proxy.stats())),
    reset: () => {
      Object.assign(baseline, JSON.parse(JSON.stringify(proxy.stats())));
    },
    proxy,
  };
  (window as unknown as { __nodeProxy: Inspectors }).__nodeProxy = inspectors;

  // Install a global hook the proxy uses to emit per-batch full-miss
  // diagnostics. Lets the testnet e2e correlate "PXE asked for this
  // tag, we hadn't warmed it" — the key signal when hit rate is stuck
  // below 100%.
  (globalThis as { __nodeProxyDiagMiss?: (line: string) => void }).__nodeProxyDiagMiss = (
    line: string,
  ) => console.info(`[node-proxy:miss] ${line}`);

  const interval = options.autoDumpMs ?? 5_000;
  let lastCalls = 0;
  const handle = setInterval(() => {
    const s = proxy.stats();
    const totalCalls = Object.values(s.methods).reduce((acc, m) => acc + m.calls, 0);
    if (totalCalls === lastCalls) return;
    lastCalls = totalCalls;
    console.info(formatTable(s));
  }, interval);

  return () => {
    clearInterval(handle);
    delete (window as unknown as { __nodeProxy?: Inspectors }).__nodeProxy;
    delete (globalThis as { __nodeProxyDiagMiss?: (line: string) => void })
      .__nodeProxyDiagMiss;
  };
}
