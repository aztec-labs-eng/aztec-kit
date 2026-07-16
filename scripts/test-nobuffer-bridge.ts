/**
 * Experiment: exercise the kit's L1→L2 fee-juice bridge with the transport-level
 * `eth_estimateGas` ×3 multiplier neutralized (see the diff in
 * `packages/common/src/bridging/utils.ts` on this branch), and MEASURE how much
 * gas headroom each L1 tx actually carries.
 *
 * Hypothesis: aztec-packages #24607 (present in @aztec/* 5.0.0) makes
 * `L1FeeJuicePortalManager.bridgeTokensPublic` send the Inbox deposit through
 * `L1TxUtils.sendAndMonitorTransaction(..., inboxDepositGasConfig())`, which
 * bumps the gas limit by `max(L1_GAS_LIMIT_BUFFER_PERCENTAGE, 100)`% — i.e. a
 * built-in 2× buffer — so the kit's transport hack is redundant.
 *
 * Method: spin up the kit's in-process local network, put a *passive*
 * JSON-RPC logging proxy in front of anvil (observation only — results are
 * forwarded untouched), and run:
 *
 *   phase A ("nobuffer"): 8 bridges via the MODIFIED `bridgeFeeJuice`
 *     (transport multiplier hard-set to 1n).
 *   phase B ("control"):  3 bridges via the ORIGINAL `bridgeFeeJuice`
 *     (verbatim copy in `utils-original.ts`, transport multiplier default ×3).
 *
 * For every L1 tx we correlate the raw `eth_estimateGas` RPC result with the
 * signed tx's gasLimit (parsed from `eth_sendRawTransaction`) and the receipt's
 * gasUsed/status. Expected gasLimit/estimate ratios per tx kind:
 *
 *   mint/approve (default L1TxUtils buffer): ≈1.2
 *   deposit, phase A                        : ≈2.0  ← the #24607 buffer
 *   deposit, phase B                        : ≈6.0  ← ×3 transport hack stacked
 *                                                     on top of the 2× buffer
 *
 * Run from the repo root:
 *   node --experimental-transform-types scripts/test-nobuffer-bridge.ts
 */
import { setupLocalNetwork } from "../packages/common/src/testing/local-network.ts";
import { bridgeFeeJuice } from "../packages/common/src/bridging/utils.ts";
import { bridgeFeeJuice as bridgeFeeJuiceOriginal } from "../packages/common/src/bridging/utils-original.ts";
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/foundation/curves/bn254";
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import { parseTransaction, type Hex } from "viem";

/** anvil dev account #0 — the L1 deployer, so also the FeeAssetHandler owner (mint is owner-gated). */
const L1_FUNDER_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const N_TEST_BRIDGES = 8;
const N_CONTROL_BRIDGES = 3;
const MSG_READY_TIMEOUT_MS = 300_000;

// ─── passive JSON-RPC logging proxy ──────────────────────────────────────────

interface EstimateRecord {
  kind: "estimate";
  phase: string;
  bridge: number;
  to?: string;
  selector?: string;
  result: bigint;
  consumed?: boolean;
}
interface SendRecord {
  kind: "send";
  phase: string;
  bridge: number;
  hash: string;
  to?: string;
  selector?: string;
  gasLimit: bigint;
}
type Record_ = EstimateRecord | SendRecord;

const records: Record_[] = [];
let currentPhase = "setup";
let currentBridge = -1;

function inspect(req: { method?: string; params?: unknown[] }, res: { result?: unknown }): void {
  try {
    if (req.method === "eth_estimateGas" && typeof res.result === "string") {
      const call = (req.params?.[0] ?? {}) as { to?: string; data?: string };
      records.push({
        kind: "estimate",
        phase: currentPhase,
        bridge: currentBridge,
        to: call.to?.toLowerCase(),
        selector: call.data?.slice(0, 10),
        result: BigInt(res.result),
      });
    } else if (req.method === "eth_sendRawTransaction" && typeof res.result === "string") {
      const tx = parseTransaction(req.params?.[0] as Hex);
      records.push({
        kind: "send",
        phase: currentPhase,
        bridge: currentBridge,
        hash: res.result,
        to: tx.to?.toLowerCase(),
        selector: tx.data?.slice(0, 10),
        gasLimit: tx.gas ?? 0n,
      });
    }
  } catch (err) {
    console.error("proxy inspect error (ignored):", err);
  }
}

async function startProxy(target: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
        .then(async (upstream) => {
          const text = await upstream.text();
          try {
            const reqJson = JSON.parse(body) as unknown;
            const resJson = JSON.parse(text) as unknown;
            if (Array.isArray(reqJson)) {
              const resById = new Map(
                (resJson as { id: number }[]).map((r) => [r.id, r] as const),
              );
              for (const r of reqJson as { id: number; method?: string; params?: unknown[] }[]) {
                inspect(r, (resById.get(r.id) ?? {}) as { result?: unknown });
              }
            } else {
              inspect(
                reqJson as { method?: string; params?: unknown[] },
                resJson as { result?: unknown },
              );
            }
          } catch {
            /* non-JSON traffic — forward untouched */
          }
          res.writeHead(upstream.status, { "content-type": "application/json" });
          res.end(text);
        })
        .catch((err) => {
          res.writeHead(502);
          res.end(JSON.stringify({ error: String(err) }));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("proxy failed to bind");
  return { url: `http://127.0.0.1:${addr.port}`, server };
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error("Setting up in-process local network...");
  const net = await setupLocalNetwork();
  const { node, l1RpcUrl, l1ChainId } = net;
  const { url: proxyUrl, server: proxy } = await startProxy(l1RpcUrl);
  console.error(`anvil at ${l1RpcUrl}, logging proxy at ${proxyUrl}`);

  const l1Addresses = await node.getL1ContractAddresses();
  const label = new Map<string, string>();
  label.set(l1Addresses.feeJuicePortalAddress.toString().toLowerCase(), "deposit(portal)");
  label.set(l1Addresses.feeJuiceAddress.toString().toLowerCase(), "approve(token)");
  if (l1Addresses.feeAssetHandlerAddress) {
    label.set(l1Addresses.feeAssetHandlerAddress.toString().toLowerCase(), "mint(handler)");
  }
  console.error("portal:", l1Addresses.feeJuicePortalAddress.toString());
  console.error("token :", l1Addresses.feeJuiceAddress.toString());
  console.error("handler:", l1Addresses.feeAssetHandlerAddress?.toString());

  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(l1RpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error) throw new Error(`rpc ${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  };

  const leafIndices: { phase: string; bridge: number; leafIndex: string; msgHash: string }[] = [];

  const runBridge = async (
    phase: string,
    i: number,
    fn: typeof bridgeFeeJuice,
  ): Promise<void> => {
    currentPhase = phase;
    currentBridge = i;
    const recipient = await AztecAddress.random();
    console.error(`\n[${phase} #${i}] bridging to ${recipient.toString()}`);
    const { claim, minted } = await fn({
      node,
      l1RpcUrl: proxyUrl,
      l1ChainId,
      recipient,
      l1PrivateKey: L1_FUNDER_KEY,
    });
    console.error(
      `[${phase} #${i}] deposit mined. minted=${minted} leafIndex=${claim.messageLeafIndex} msgHash=${claim.messageHash}`,
    );
    leafIndices.push({
      phase,
      bridge: i,
      leafIndex: String(claim.messageLeafIndex),
      msgHash: String(claim.messageHash),
    });

    // Wait until the L1→L2 message is actually consumable on L2, warping
    // time via the in-process node's debug API (no HTTP node URL needed).
    const messageHash = Fr.fromHexString(String(claim.messageHash));
    const deadline = Date.now() + MSG_READY_TIMEOUT_MS;
    while (!(await isL1ToL2MessageReady(node, messageHash))) {
      if (Date.now() > deadline) {
        throw new Error(`[${phase} #${i}] message ${claim.messageHash} not ready in time`);
      }
      await (
        node as unknown as { warpL2TimeAtLeastBy: (s: number) => Promise<unknown> }
      ).warpL2TimeAtLeastBy(36);
      await new Promise((r) => setTimeout(r, 250));
    }
    console.error(`[${phase} #${i}] L1→L2 message READY.`);
  };

  let failure: unknown;
  try {
    for (let i = 0; i < N_TEST_BRIDGES; i++) {
      await runBridge("nobuffer", i, bridgeFeeJuice);
    }
    for (let i = 0; i < N_CONTROL_BRIDGES; i++) {
      await runBridge("control-x3", i, bridgeFeeJuiceOriginal);
    }
  } catch (err) {
    failure = err;
    console.error("BRIDGE FAILURE:", err);
  }

  // ── correlate sends with estimates + fetch receipts ────────────────────────
  currentPhase = "report";
  const rows: {
    phase: string;
    bridge: number;
    tx: string;
    estimate: string;
    gasLimit: string;
    gasUsed: string;
    limitOverEstimate: string;
    usedOverEstimate: string;
    status: string;
    hash: string;
  }[] = [];

  for (const send of records.filter((r): r is SendRecord => r.kind === "send")) {
    // latest unconsumed estimate for the same target+selector before this send
    let est: EstimateRecord | undefined;
    for (const r of records) {
      if (r === send) break;
      if (r.kind === "estimate" && !r.consumed && r.to === send.to && r.selector === send.selector) {
        est = r;
      }
    }
    if (est) est.consumed = true;
    const receipt = (await rpc("eth_getTransactionReceipt", [send.hash])) as {
      gasUsed?: string;
      status?: string;
    } | null;
    const gasUsed = receipt?.gasUsed ? BigInt(receipt.gasUsed) : undefined;
    const ratio = (a?: bigint, b?: bigint): string =>
      a !== undefined && b !== undefined && b !== 0n ? (Number(a) / Number(b)).toFixed(3) : "n/a";
    rows.push({
      phase: send.phase,
      bridge: send.bridge,
      tx: label.get(send.to ?? "") ?? `${send.to} ${send.selector}`,
      estimate: est ? est.result.toString() : "n/a",
      gasLimit: send.gasLimit.toString(),
      gasUsed: gasUsed?.toString() ?? "n/a",
      limitOverEstimate: ratio(send.gasLimit, est?.result),
      usedOverEstimate: ratio(gasUsed, est?.result),
      status: receipt?.status === "0x1" ? "ok" : (receipt?.status ?? "??"),
      hash: send.hash,
    });
  }

  console.log("\n=== MEASUREMENTS ===");
  console.table(rows.map(({ hash: _hash, ...r }) => r));
  console.log("\n=== L1→L2 MESSAGE LEAF INDICES ===");
  console.table(leafIndices);

  const out = {
    rows,
    leafIndices,
    failure: failure ? String(failure) : null,
  };
  const outPath = process.env.RESULTS_JSON ?? "/tmp/test-nobuffer-bridge-results.json";
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`results written to ${outPath}`);

  await net.stop();
  proxy.close();
  if (failure) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
