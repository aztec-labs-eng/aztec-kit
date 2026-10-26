/**
 * Dev-only inspector for SQLite-OPFS stores. When registered, exposes
 * `window.__aztecStores` with ad-hoc query + export helpers so the DB contents
 * can be examined from the browser DevTools console. No-op in SSR.
 */

import type { AztecAsyncKVStore } from "@aztec-labs/kv-store";

interface InspectableStore extends AztecAsyncKVStore {
  allAsync(sql: string, bind?: unknown[]): Promise<unknown[][]>;
  exportDb(): Promise<Uint8Array>;
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

async function summarize(
  store: InspectableStore,
): Promise<Array<{ container: string; rows: number }>> {
  const rows = await store.allAsync(
    "SELECT container, count(*) AS n FROM data GROUP BY container ORDER BY n DESC",
  );
  return rows.map((r) => ({ container: String(r[0]), rows: Number(r[1]) }));
}

export type SqliteInspectors = {
  pxe: InspectableStore;
  wallet: InspectableStore;
  downloadPxe(): Promise<void>;
  downloadWallet(): Promise<void>;
  summary(): Promise<{
    pxe: Array<{ container: string; rows: number }>;
    wallet: Array<{ container: string; rows: number }>;
  }>;
};

export function registerSqliteInspectors(stores: {
  pxe: InspectableStore;
  wallet: InspectableStore;
}): void {
  if (typeof window === "undefined") return;
  const inspectors: SqliteInspectors = {
    pxe: stores.pxe,
    wallet: stores.wallet,
    downloadPxe: async () => downloadBytes(await stores.pxe.exportDb(), "pxe.sqlite"),
    downloadWallet: async () => downloadBytes(await stores.wallet.exportDb(), "wallet.sqlite"),
    summary: async () => ({
      pxe: await summarize(stores.pxe),
      wallet: await summarize(stores.wallet),
    }),
  };
  (window as unknown as { __aztecStores: SqliteInspectors }).__aztecStores = inspectors;
}
