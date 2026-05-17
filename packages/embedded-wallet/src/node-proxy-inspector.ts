/**
 * Dev-only inspector. When the wallet is constructed with `inspect: true`,
 * exposes `window.__nodeProxy.stats()` (raw counters for tests/devtools)
 * and auto-dumps a one-shot table to the console every ~5 seconds if
 * anything has changed. Nothing here is load-bearing for cache behavior.
 */

import type { CachingNodeProxy, CacheStats } from "./node-proxy";

function formatTable(stats: CacheStats): string {
  const rows: string[] = [];
  const methods = Object.entries(stats.methods).sort((a, b) => b[1].calls - a[1].calls);
  for (const [name, c] of methods) {
    const hitRate = c.calls > 0 ? ((c.hits / c.calls) * 100).toFixed(0) + "%" : "-";
    const elem = c.elements ? ` el=${c.elements.hits}/${c.elements.seen}` : "";
    rows.push(
      `  ${name.padEnd(36)} calls=${String(c.calls).padStart(4)} ` +
        `hits=${String(c.hits).padStart(4)} miss=${String(c.misses).padStart(4)} ` +
        `up=${String(c.upstream).padStart(4)} hitRate=${hitRate.padStart(4)}${elem}`,
    );
  }
  const tip = stats.proposed ? `${stats.proposed.number}/${stats.proposed.hash.slice(0, 8)}…` : "—";
  return [
    `[node-proxy] tip(proposed)=${tip} finalized=${stats.finalizedAt ?? "—"} ring=${stats.ringSize}`,
    `[node-proxy] cache: permanent=${stats.permanent} speculative=${stats.speculative} tagLogBB=${stats.tagLogBlockBounded} leafIdxBB=${stats.leafIndexBlockBounded}`,
    rows.length > 0 ? `[node-proxy] per-method:\n${rows.join("\n")}` : `[node-proxy] no calls yet`,
  ].join("\n");
}

export function registerNodeProxyInspector(
  proxy: CachingNodeProxy,
  options: { autoDumpMs?: number } = {},
): () => void {
  if (typeof window === "undefined") return () => undefined;
  (window as unknown as { __nodeProxy: { stats: () => CacheStats; dump: () => void } }).__nodeProxy = {
    stats: () => proxy.stats(),
    dump: () => console.info(formatTable(proxy.stats())),
  };
  const interval = options.autoDumpMs ?? 5_000;
  let lastCalls = 0;
  const handle = setInterval(() => {
    const s = proxy.stats();
    const total = Object.values(s.methods).reduce((a, m) => a + m.calls, 0);
    if (total === lastCalls) return;
    lastCalls = total;
    console.info(formatTable(s));
  }, interval);
  return () => {
    clearInterval(handle);
    delete (window as unknown as { __nodeProxy?: unknown }).__nodeProxy;
  };
}
