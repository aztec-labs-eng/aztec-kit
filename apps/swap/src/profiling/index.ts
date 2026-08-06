/**
 * Profiling orchestrator.
 *
 * Instruments the embedded wallet, PXE, node client, fetch, and WASM from
 * the outside — no wallet code changes needed.
 *
 * Parent attribution uses async-context propagation via zone.js (see
 * `context.ts`). Every span carries an explicit `parentId` based on the
 * actual causal chain, so concurrent async operations never get confused
 * with nested ones — no timing heuristics.
 *
 * Usage:
 *   await profiler.install();               // global interceptors
 *   profiler.instrumentWallet(wallet);       // wrap wallet + its PXE + node
 *   profiler.start('sendTx');
 *   // ... perform operation ...
 *   const report = profiler.stop();
 */

import {
  installFetchInterceptor,
  installWasmInterceptor,
  installSimulatorInterceptorFromPXE,
} from "./interceptors";
import {
  currentSpan,
  runInSpan,
  zoneAvailable,
  bindCurrentZone,
  type SpanContext,
} from "./context";
import type { Category, ProfileRecord, ProfileReport } from "./types";

export type { Category, ProfileRecord, ProfileReport } from "./types";

// ─── Method wrapping ─────────────────────────────────────────────────────────

// Methods to skip — internal plumbing, getters, or things that break if wrapped.
const SKIP = new Set([
  // JS fundamentals
  "constructor",
  "toString",
  "toJSON",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "then", // wrapping 'then' would break Promise detection
  "catch",
  "finally",
  // Logging
  "log",
  "warn",
  "error",
  "debug",
  "info",
  "verbose",
  "trace",
  // Lifecycle (often called during init, not during profiled operations)
  "dispose",
  "destroy",
  // Event emitter
  "on",
  "off",
  "once",
  "emit",
  "addListener",
  "removeListener",
  "addEventListener",
  "removeEventListener",
]);

/**
 * Collect all method names from an object and its prototype chain,
 * stopping at Object.prototype.
 */
function collectMethods(target: any): string[] {
  const seen = new Set<string>();
  let obj = target;
  while (obj && obj !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (SKIP.has(name) || name.startsWith("_")) continue;
      try {
        if (typeof obj[name] === "function" && !seen.has(name)) {
          seen.add(name);
        }
      } catch {
        // getter that throws — skip
      }
    }
    obj = Object.getPrototypeOf(obj);
  }
  return [...seen];
}

/**
 * Whether reading each of `methods` twice yields the same function.
 *
 * A Proxy that synthesizes methods in its `get` trap answers with a fresh
 * function on every read while forwarding writes to the object underneath —
 * PXE's caching node wrapper (`withCache`) is one, handing back either a
 * per-read `value.bind(target)` or its own caching closure. Wrapping such an
 * object installs our wrapper *below* the trap, and the trap's closure then
 * calls straight back into it: unbounded recursion, which surfaces as
 * "Maximum call stack size exceeded" on the first node read. If we can't
 * observe our own writes we don't own the methods, so we leave them alone.
 */
function hasStableMethods(target: any, methods: string[]): boolean {
  return methods.every((name) => {
    try {
      return target[name] === target[name];
    } catch {
      return false;
    }
  });
}

function wrapAllMethods(target: any, category: Category, profiler: Profiler): () => void {
  const restores: (() => void)[] = [];
  const methods = collectMethods(target);
  const wrappedNames: string[] = [];

  if (!hasStableMethods(target, methods)) {
    console.info(`[profiler] skipped ${category}: proxy-synthesized methods, not safe to wrap`);
    return () => {};
  }

  for (const name of methods) {
    const original = target[name];
    if (typeof original !== "function" || (original as any).__profiled) continue;

    const wrapped = function (this: any, ...args: any[]) {
      if (!profiler.isRecording) return original.apply(this, args);
      // Bind any callback-like arguments to the current zone so that custom
      // queues / schedulers that call them later don't lose async context.
      // (Zone.js handles Promise/setTimeout/addEventListener natively, but
      // user-space callback patterns like SerialQueue.put need this.)
      const boundArgs = args.map((a) =>
        typeof a === "function" && !(a as any).__zoneBound ? bindCurrentZone(a) : a,
      );
      return profiler.runSpan(name, category, () => original.apply(this, boundArgs));
    };
    (wrapped as any).__profiled = true;
    try {
      target[name] = wrapped;
      wrappedNames.push(name);
      restores.push(() => {
        target[name] = original;
      });
    } catch (e) {
      console.warn(`[profiler] Could not wrap ${category}.${name}:`, e);
    }
  }

  console.info(
    `[profiler] wrapped ${category} (${wrappedNames.length} methods):`,
    wrappedNames.slice(0, 10).join(", ") + (wrappedNames.length > 10 ? ", ..." : ""),
  );
  return () => restores.forEach((r) => r());
}

/** Detect queue-like objects whose `get`/`put`/`process` are worker-loop
 *  infrastructure, not application operations. Their blocking `get()` can
 *  span seconds of idle time and pollute the profile. */
function isQueueLike(obj: any): boolean {
  try {
    return typeof obj.get === "function" && typeof obj.put === "function";
  } catch {
    return false;
  }
}

// ─── Profiler ────────────────────────────────────────────────────────────────

class Profiler {
  private _recording = false;
  private _origin = 0;
  private _startedAt = 0;
  private _name = "";
  private _records: ProfileRecord[] = [];
  private _cleanups: (() => void)[] = [];
  private _installed = false;
  private _installPromise: Promise<void> | undefined;
  private _instrumentedWallets = new WeakSet<object>();
  /** Generation counter — incremented on each start() so leaked zones from a
   *  previous recording can't pollute the current one, and spans that started
   *  during the current recording can still finalize after stop(). */
  private _generation = 0;

  get isRecording() {
    return this._recording;
  }
  get isInstalled() {
    return this._installed;
  }

  /**
   * Push a completed record. Called by interceptors and method wrappers.
   * Accepts records from the given generation even after stop(), so spans
   * whose promise resolves after stop() still get their duration recorded.
   */
  record(
    generation: number,
    id: string,
    parentId: string | null,
    name: string,
    category: Category,
    startAbsolute: number,
    duration: number,
    detail?: string,
    error?: boolean,
  ) {
    if (generation !== this._generation) return;
    this._records.push({
      id,
      parentId,
      name,
      category,
      start: startAbsolute - this._origin,
      duration,
      detail,
      error,
    });
  }

  /**
   * Run `fn` as a profiled span. Enters a new zone carrying the span
   * context so any nested async operations can discover this span as
   * their parent via `currentSpan()`.
   *
   * @param parentOverride - If provided, used as the span's parent instead
   *   of whatever `currentSpan()` returns. The new zone is still forked
   *   from `Zone.current` (so downstream callbacks in it see OUR new span),
   *   only the recorded `parentId` is changed. Useful for re-parenting
   *   batched fetches out from under the node call that happened to schedule
   *   the batch's setTimeout.
   */
  runSpan<T>(
    name: string,
    category: Category,
    fn: () => T | Promise<T>,
    detail?: string,
    parentOverride?: SpanContext | null,
  ): T | Promise<T> {
    if (!this._recording) return fn();

    const generation = this._generation;
    const parent = parentOverride !== undefined ? parentOverride : currentSpan();
    const span: SpanContext = {
      id: crypto.randomUUID(),
      parentId: parent?.id ?? null,
      name,
      category,
    };
    const t0 = performance.now();

    const finalize = (error?: boolean) => {
      this.record(
        generation,
        span.id,
        span.parentId,
        name,
        category,
        t0,
        performance.now() - t0,
        detail,
        error,
      );
    };

    return runInSpan(span, () => {
      let result: T | Promise<T>;
      try {
        result = fn();
      } catch (e) {
        finalize(true);
        throw e;
      }
      if (result && typeof (result as any).then === "function") {
        return (result as Promise<T>).then(
          (v) => {
            finalize();
            return v;
          },
          (e) => {
            finalize(true);
            throw e;
          },
        );
      }
      finalize();
      return result;
    });
  }

  /** Install global interceptors (fetch, bb.js WASM, standalone fns). Call once before wallet creation. */
  async install() {
    if (this._installed) return this._installPromise;
    // Set the flag BEFORE any await to prevent concurrent double-install.
    this._installed = true;
    this._installPromise = (async () => {
      this._cleanups.push(installFetchInterceptor(this));
      this._cleanups.push(await installWasmInterceptor(this));
    })();
    return this._installPromise;
  }

  /**
   * Manually instrument a code block. Convenience wrapper around `runSpan`.
   * @example
   *   await profiler.span('myOperation', 'wallet', async () => { ... });
   */
  span<T>(name: string, category: Category, fn: () => T | Promise<T>): T | Promise<T> {
    return this.runSpan(name, category, fn);
  }

  /** Wrap a wallet instance + its internal PXE + node + PXE stores. Call once per wallet. */
  instrumentWallet(wallet: any) {
    if (this._instrumentedWallets.has(wallet)) return;
    this._instrumentedWallets.add(wallet);

    const wrapped = new Set<any>();

    wrapped.add(wallet);
    this._cleanups.push(wrapAllMethods(wallet, "wallet", this));

    const node = wallet.aztecNode;
    if (node) {
      wrapped.add(node);
      this._cleanups.push(wrapAllMethods(node, "node", this));
    }

    const pxe = wallet.pxe;
    if (pxe) {
      wrapped.add(pxe);
      this._cleanups.push(wrapAllMethods(pxe, "pxe", this));

      if (pxe.simulator) wrapped.add(pxe.simulator);
      this._cleanups.push(installSimulatorInterceptorFromPXE(pxe, this));

      this.instrumentInternals(pxe, wrapped, 3);
    }
  }

  /**
   * Walk an object's properties and wrap methods on sub-objects.
   * Recurses up to `depth` levels (default 2) to catch nested objects
   * like `jobCoordinator.kvStore` whose `transactionAsync` needs its
   * callback arg zone-bound for proper context propagation.
   *
   * Queue-like objects (BaseMemoryQueue, FifoQueue, etc.) are skipped:
   * their `get`/`put`/`process` methods are worker-loop infrastructure
   * that blocks for seconds waiting for items, not application operations.
   */
  private instrumentInternals(root: any, alreadyWrapped: Set<any>, depth = 2) {
    if (depth <= 0) return;
    for (const key of Object.getOwnPropertyNames(root)) {
      if (key.startsWith("_") || key === "log") continue;
      let value: any;
      try {
        value = root[key];
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || alreadyWrapped.has(value)) continue;

      const methods = collectMethods(value);
      if (methods.length === 0) continue;

      // Skip queue-like objects — they have `get`+`put` (or `process`)
      // and their blocking `get()` can span seconds of idle time.
      if (isQueueLike(value)) {
        alreadyWrapped.add(value);
        continue;
      }

      alreadyWrapped.add(value);
      this._cleanups.push(wrapAllMethods(value, "store", this));
      this.instrumentInternals(value, alreadyWrapped, depth - 1);
    }
  }

  start(name = "profile") {
    if (this._recording) return;
    this._name = name;
    this._origin = performance.now();
    this._startedAt = Date.now();
    this._records = [];
    this._generation++;
    this._recording = true;
    console.info(
      `[profiler] Started: "${name}" — zone tracking: ${zoneAvailable() ? "on" : "OFF (every span will be a root)"}`,
    );
  }

  stop(): ProfileReport {
    if (!this._recording) {
      return { name: "", startedAt: 0, durationMs: 0, records: [] };
    }
    this._recording = false;
    const durationMs = performance.now() - this._origin;
    const report: ProfileReport = {
      name: this._name,
      startedAt: this._startedAt,
      durationMs,
      records: [...this._records],
    };
    console.info(
      `[profiler] Stopped: "${this._name}" — ${(durationMs / 1000).toFixed(2)}s, ` +
        `${report.records.length} spans`,
    );
    return report;
  }

  download(report: ProfileReport) {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `profile-${report.name}-${new Date(report.startedAt).toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  uninstall() {
    this._cleanups.forEach((c) => c());
    this._cleanups = [];
    this._installed = false;
  }
}

export const profiler = new Profiler();
export type { Profiler };
