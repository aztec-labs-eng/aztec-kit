/**
 * Fetch + WASM + simulator + standalone-function interception for profiling.
 *
 * All interceptors take the `Profiler` instance directly and use its
 * `runSpan` method to wrap operations. That routes the work through
 * `runInSpan` (zone.js), so async context propagates and every captured
 * span carries the correct `parentId`.
 */

import type { Profiler } from "./index";
import { findAncestorSpan } from "./context";

// Categories to skip when re-parenting batched fetches. A batched RPC call
// is triggered by a setTimeout scheduled inside a `node` method, so it ends
// up nested under that first node call. Skipping `node` makes the batch
// record a sibling of the node calls it groups.
const SKIP_FOR_BATCH_PARENT = new Set(["node" as const, "rpc" as const]);

// ─── Fetch interceptor ──────────────────────────────────────────────────────

export function installFetchInterceptor(profiler: Profiler): () => void {
  const original = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!profiler.isRecording) return original(input, init);

    // Only instrument JSON-RPC POST requests. Skip WASM binary downloads,
    // static assets, etc. — these pollute the profile with huge blobs.
    if (!init?.body || typeof init.body !== "string") return original(input, init);

    let method = "";
    let batched = false;
    try {
      const parsed = JSON.parse(init.body);
      if (Array.isArray(parsed)) {
        batched = true;
        method = parsed.map((r: any) => r?.method ?? "?").join(", ");
      } else if (parsed?.method) {
        method = parsed.method;
      }
    } catch {
      return original(input, init);
    }
    if (!method) return original(input, init);

    const label = batched ? `[batch] ${method}` : method;

    // For batched fetches, re-parent above any node ancestors so the batch
    // is a sibling of the node calls it bundled (rather than nested under
    // the first one, which is where setTimeout happened to land).
    const parentOverride = batched ? (findAncestorSpan(SKIP_FOR_BATCH_PARENT) ?? null) : undefined;

    return profiler.runSpan(
      label,
      "rpc",
      async () => {
        return await original(input, init);
      },
      undefined,
      parentOverride,
    ) as Promise<Response>;
  };

  return () => {
    window.fetch = original;
  };
}

// ─── Msgpack operation name decoder ─────────────────────────────────────────
// bb.js backend.call receives msgpack-encoded [["OperationName", ...args]].
// We extract just the operation name from the first few bytes.

function decodeMsgpackOpName(buf: Uint8Array): string | null {
  try {
    let pos = 0;
    const u8 = (o: number) => buf[o];

    // Outer fixarray header (0x90..0x9f)
    const outer = u8(pos++);
    if ((outer & 0xf0) !== 0x90) return null;
    // Inner fixarray header
    const inner = u8(pos++);
    if ((inner & 0xf0) !== 0x90) return null;
    // String header
    const strHdr = u8(pos++);
    let strLen: number;
    if ((strHdr & 0xe0) === 0xa0) {
      strLen = strHdr & 0x1f; // fixstr
    } else if (strHdr === 0xd9) {
      strLen = u8(pos++); // str 8
    } else {
      return null;
    }
    let name = "";
    for (let i = 0; i < strLen && pos < buf.length; i++) {
      name += String.fromCharCode(u8(pos++));
    }
    return name || null;
  } catch {
    return null;
  }
}

// ─── WASM interceptor ───────────────────────────────────────────────────────

function wrapBackendCall(backend: any, profiler: Profiler, isSync: boolean): () => void {
  if (!backend || typeof backend.call !== "function" || backend.call.__profiled) return () => {};

  const original = backend.call.bind(backend);

  if (isSync) {
    backend.call = function (inputBuffer: Uint8Array) {
      if (!profiler.isRecording) return original(inputBuffer);
      const opName = decodeMsgpackOpName(inputBuffer) ?? "bb_sync";
      return profiler.runSpan(opName, "wasm", () => original(inputBuffer));
    };
  } else {
    backend.call = function (inputBuffer: Uint8Array) {
      if (!profiler.isRecording) return original(inputBuffer);
      const opName = decodeMsgpackOpName(inputBuffer) ?? "bb_async";
      return profiler.runSpan(opName, "wasm", () => original(inputBuffer));
    };
  }

  backend.call.__profiled = true;
  return () => {
    backend.call = original;
  };
}

export async function installWasmInterceptor(profiler: Profiler): Promise<() => void> {
  const restores: (() => void)[] = [];

  try {
    const bbMod = await import("@aztec-foundation/bb.js");
    const BB = (bbMod as any).Barretenberg;
    const BBSync = (bbMod as any).BarretenbergSync;

    // Patch BarretenbergSync (main-thread hashing: poseidon, pedersen, etc.)
    if (BBSync) {
      try {
        const existing = BBSync.getSingleton();
        if (existing?.backend) restores.push(wrapBackendCall(existing.backend, profiler, true));
      } catch {
        /* not yet init'd */
      }

      if (BBSync.initSingleton && !BBSync.initSingleton.__profiled) {
        const orig = BBSync.initSingleton.bind(BBSync);
        BBSync.initSingleton = async (...args: any[]) => {
          const inst = await orig(...args);
          if (inst?.backend) restores.push(wrapBackendCall(inst.backend, profiler, true));
          return inst;
        };
        BBSync.initSingleton.__profiled = true;
        restores.push(() => {
          BBSync.initSingleton = orig;
        });
      }
    }

    // Patch Barretenberg (async — proving worker, less important but still useful)
    if (BB) {
      try {
        const existing = BB.getSingleton();
        if (existing?.backend) restores.push(wrapBackendCall(existing.backend, profiler, false));
      } catch {
        /* not yet init'd */
      }

      if (BB.initSingleton && !BB.initSingleton.__profiled) {
        const orig = BB.initSingleton.bind(BB);
        BB.initSingleton = async (...args: any[]) => {
          const inst = await orig(...args);
          if (inst?.backend) restores.push(wrapBackendCall(inst.backend, profiler, false));
          return inst;
        };
        BB.initSingleton.__profiled = true;
        restores.push(() => {
          BB.initSingleton = orig;
        });
      }
    }
  } catch {
    // @aztec-foundation/bb.js not available — no WASM profiling
  }

  return () => restores.forEach((r) => r());
}

// ─── Simulator + oracle callback interceptor ───────────────────────────────

/**
 * Wrap every method on an ACIRCallback (oracle) object with profiling.
 * Each key is an oracle function name (getNotes, getPublicDataTreeWitness, ...).
 *
 * We return a NEW object with wrapped methods — the original callback is
 * left untouched (the ACVM only sees our wrapped version).
 */
function wrapOracleCallback(callback: any, profiler: Profiler): any {
  if (!callback || typeof callback !== "object") return callback;

  const wrapped: any = {};
  for (const key of Object.keys(callback)) {
    const original = callback[key];
    if (typeof original !== "function") {
      wrapped[key] = original;
      continue;
    }
    wrapped[key] = function (...args: any[]) {
      if (!profiler.isRecording) return original.apply(this, args);
      return profiler.runSpan(key, "oracle", () => original.apply(this, args));
    };
  }
  return wrapped;
}

/**
 * Patch circuit simulator prototypes by reaching through the PXE instance.
 * This avoids importing @aztec-labs/simulator or @aztec-labs/pxe/server (which have
 * native Node.js deps that break browser builds).
 *
 * Patches:
 *   - executeUserCircuit: records the circuit execution + wraps the oracle
 *     callback so every oracle call gets its own span.
 *   - executeProtocolCircuit: records protocol circuit execution.
 */
export function installSimulatorInterceptorFromPXE(pxe: any, profiler: Profiler): () => void {
  const restores: (() => void)[] = [];

  const sim = pxe?.simulator;
  if (!sim) return () => {};

  const simProto = Object.getPrototypeOf(sim);
  if (!simProto) return () => {};

  if (
    typeof simProto.executeUserCircuit === "function" &&
    !simProto.executeUserCircuit.__profiled
  ) {
    const original = simProto.executeUserCircuit;
    simProto.executeUserCircuit = function (
      this: any,
      input: any,
      artifact: any,
      callback: any,
      ...rest: any[]
    ) {
      if (!profiler.isRecording) return original.call(this, input, artifact, callback, ...rest);
      const name = artifact?.name ?? artifact?.functionName ?? "circuit";
      const contract = artifact?.contractName ?? "";
      const label = contract ? `${contract}:${name}` : name;
      const wrappedCallback = wrapOracleCallback(callback, profiler);
      return profiler.runSpan(label, "sim", () =>
        original.call(this, input, artifact, wrappedCallback, ...rest),
      );
    };
    simProto.executeUserCircuit.__profiled = true;
    restores.push(() => {
      simProto.executeUserCircuit = original;
    });
  }

  if (
    typeof simProto.executeProtocolCircuit === "function" &&
    !simProto.executeProtocolCircuit.__profiled
  ) {
    const original = simProto.executeProtocolCircuit;
    simProto.executeProtocolCircuit = function (
      this: any,
      input: any,
      artifact: any,
      callback: any,
      ...rest: any[]
    ) {
      if (!profiler.isRecording) return original.call(this, input, artifact, callback, ...rest);
      const label = artifact?.name ?? "protocol_circuit";
      const wrappedCallback =
        callback && typeof callback === "object"
          ? wrapOracleCallback(callback, profiler)
          : callback;
      return profiler.runSpan(label, "sim", () =>
        original.call(this, input, artifact, wrappedCallback, ...rest),
      );
    };
    simProto.executeProtocolCircuit.__profiled = true;
    restores.push(() => {
      simProto.executeProtocolCircuit = original;
    });
  }

  return () => restores.forEach((r) => r());
}

// Note: standalone functions imported via `import { foo } from 'bar'`
// (e.g. `simulateViaNode`, `waitForTx`) aren't captured. ESM imports are
// live bindings to the exporter's local variable, not the namespace object,
// so runtime monkey-patching of the namespace doesn't affect existing
// imports in other modules. The work these functions do is still visible
// via the interceptors that capture their internals (RPC/fetch for
// `simulateViaNode`, `node.getTxReceipt` polls for `waitForTx`).
