/**
 * Experiment: empirically prove that the built-in 2x Inbox-deposit gas buffer
 * (aztec-packages #24607, `INBOX_DEPOSIT_GAS_LIMIT_BUFFER_PERCENTAGE = 100` in
 * `@aztec/aztec.js` 5.0.0) covers the WORST-CASE `Inbox.sendL2Message` insert,
 * so the kit's transport-level x3 `eth_estimateGas` multiplier (neutralized on
 * this branch, see `packages/common/src/bridging/utils.ts`) is redundant.
 *
 * The hazard: the Inbox stores L1->L2 messages in per-checkpoint incremental
 * frontier trees (verified from `Inbox.sol` / `FrontierLib.sol` at the pinned
 * aztec-packages commit: HEIGHT = L1_TO_L2_MSG_SUBTREE_HEIGHT = 10, SIZE =
 * 2^10 = 1024 leaves; global leaf index = checkpoint * 1024 + in-tree index).
 * `FrontierLib.insertLeaf` at in-tree index i hashes `trailingOnes(i)` levels:
 * an insert at index 1023 cascades 10 levels (10 cold frontier SLOADs, a fresh
 * zero->nonzero SSTORE, 10 SHA-256 precompile calls) — tens of thousands of
 * gas more than an even-index insert that touches one warm slot. A gas ESTIMATE
 * taken at a cheap index therefore under-sizes a deposit that MINES at a
 * subtree boundary.
 *
 * Method (single run, in-process local network, direct viem-signed L1 txs so
 * no L2 blocks are produced and in-tree indices fill consecutively):
 *
 *   phase A (survey):   fill the current in-progress tree to completion
 *                       (in-tree index .. 1023), fresh eth_estimateGas before
 *                       every insert, generous gasLimit so nothing fails.
 *                       Yields the full per-level gas profile incl. the
 *                       10-level full-tree cascade.
 *   phase B (fill):     fill the next tree to in-tree index 1022.
 *   phase C (failure):  at index 1023 (worst case), send the deposit with
 *                       gasLimit = the MINIMUM estimate observed in phase A —
 *                       i.e. exactly the original kit behaviour with the x3
 *                       multiplier dropped and NO built-in buffer, estimate
 *                       taken at a cheap moment. Expect out-of-gas revert.
 *   phase D (stale 2x): same index (the revert did not consume it), gasLimit
 *                       = 2 * that same stale cheap estimate — the #24607
 *                       buffer applied to the worst possible estimate. Expect
 *                       success.
 *   phase E (kit path): fill the next tree to index 510, then run the kit's
 *                       real `bridgeFeeJuice` (transport multiplier 1n, only
 *                       the built-in 2x buffer) through a passive logging
 *                       proxy; its deposit lands at index 511 — a 9-level
 *                       cascade boundary. Expect success with
 *                       gasLimit = 2 * fresh estimate.
 *
 * Run from the repo root:
 *   node --experimental-transform-types scripts/test-worstcase-inbox.ts
 */
import { setupLocalNetwork } from "../packages/common/src/testing/local-network.ts";
import { bridgeFeeJuice } from "../packages/common/src/bridging/utils.ts";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import {
  FeeAssetHandlerAbi,
  FeeJuicePortalAbi,
  InboxAbi,
  TestERC20Abi,
} from "@aztec/l1-artifacts";
import { createServer, type Server } from "node:http";
import { writeFileSync } from "node:fs";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  padHex,
  parseTransaction,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// anvil dev account #0 — L1 deployer, FeeAssetHandler owner, and the node's
// sequencer publisher key. Used only for the one-off faucet mint and the
// final kit-path bridge (L1TxUtils does its own nonce handling).
const ACC0_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// anvil dev account #1 — the surveyor. Nobody else sends txs from this
// account, so we can track its nonce locally.
const ACC1_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const TREE_SIZE = 1024n; // 2^L1_TO_L2_MSG_SUBTREE_HEIGHT, verified vs Inbox.sol (HEIGHT = 10)
const GENEROUS_GAS = 500_000n;
const MAX_INSERTS = 4000; // hard safety cap across all phases

const trailingOnes = (n: bigint): number => {
  let c = 0;
  while ((n & 1n) === 1n) {
    c++;
    n >>= 1n;
  }
  return c;
};

interface InsertRecord {
  seq: number;
  phase: string;
  globalIndex: string;
  local: number;
  level: number;
  estimate?: string;
  gasLimit: string;
  gasUsed: string;
  status: "ok" | "reverted";
  txHash: string;
}

// ─── passive JSON-RPC logging proxy (phase E only) ───────────────────────────

interface ProxyRecord {
  kind: "estimate" | "send";
  to?: string;
  selector?: string;
  value: bigint; // estimate result, or signed-tx gasLimit
  hash?: string;
}
const proxyRecords: ProxyRecord[] = [];

function inspect(req: { method?: string; params?: unknown[] }, res: { result?: unknown }): void {
  try {
    if (req.method === "eth_estimateGas" && typeof res.result === "string") {
      const call = (req.params?.[0] ?? {}) as { to?: string; data?: string };
      proxyRecords.push({
        kind: "estimate",
        to: call.to?.toLowerCase(),
        selector: call.data?.slice(0, 10),
        value: BigInt(res.result),
      });
    } else if (req.method === "eth_sendRawTransaction" && typeof res.result === "string") {
      const tx = parseTransaction(req.params?.[0] as Hex);
      proxyRecords.push({
        kind: "send",
        to: tx.to?.toLowerCase(),
        selector: tx.data?.slice(0, 10),
        value: tx.gas ?? 0n,
        hash: res.result,
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
      fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body })
        .then(async (upstream) => {
          const text = await upstream.text();
          try {
            const reqJson = JSON.parse(body) as unknown;
            const resJson = JSON.parse(text) as unknown;
            if (Array.isArray(reqJson)) {
              const resById = new Map((resJson as { id: number }[]).map((r) => [r.id, r] as const));
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

  let rpcId = 0;
  const rpc = async (method: string, params: unknown[]): Promise<unknown> => {
    const res = await fetch(l1RpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new Error(`rpc ${method}: ${JSON.stringify(json.error)}`);
    return json.result;
  };

  const l1 = await node.getL1ContractAddresses();
  const portal = l1.feeJuicePortalAddress.toString() as Hex;
  const token = l1.feeJuiceAddress.toString() as Hex;
  const handler = l1.feeAssetHandlerAddress?.toString() as Hex;
  if (!handler) throw new Error("no fee asset handler deployed");

  const call = async (to: Hex, abi: unknown[], functionName: string, args: unknown[] = []) => {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const out = (await rpc("eth_call", [{ to, data }, "latest"])) as Hex;
    return decodeFunctionResult({ abi, functionName, data: out } as never);
  };

  const inbox = (await call(portal, FeeJuicePortalAbi as never, "INBOX")) as Hex;
  console.error(`portal=${portal} token=${token} handler=${handler} inbox=${inbox}`);

  /** (inProgress checkpoint, nextIndex within its tree), normalized past a full tree. */
  const readInboxPos = async (): Promise<{ checkpoint: bigint; nextIndex: bigint }> => {
    let checkpoint = BigInt(
      (await call(inbox, InboxAbi as never, "getInProgress")) as bigint | number,
    );
    let nextIndex = BigInt(
      (await call(inbox, InboxAbi as never, "trees", [checkpoint])) as bigint | number,
    );
    if (nextIndex === TREE_SIZE) {
      // tree is full; the next sendL2Message rolls into a fresh tree
      checkpoint += 1n;
      nextIndex = 0n;
    }
    return { checkpoint, nextIndex };
  };

  const acc0 = privateKeyToAccount(ACC0_KEY);
  const acc1 = privateKeyToAccount(ACC1_KEY);
  const maxFeePerGas = 5_000_000_000n; // 5 gwei, far above anvil's decaying base fee
  const maxPriorityFeePerGas = 1_000_000_000n;

  const sendTx = async (
    account: typeof acc1,
    nonce: number,
    to: Hex,
    data: Hex,
    gas: bigint,
  ): Promise<{ gasUsed: bigint; status: "ok" | "reverted"; logs: unknown[]; hash: string }> => {
    const raw = await account.signTransaction({
      type: "eip1559",
      chainId: l1ChainId,
      nonce,
      to,
      data,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
      value: 0n,
    });
    const hash = (await rpc("eth_sendRawTransaction", [raw])) as string;
    for (let i = 0; i < 400; i++) {
      const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as {
        gasUsed: Hex;
        status: Hex;
        logs: unknown[];
      } | null;
      if (receipt) {
        return {
          gasUsed: BigInt(receipt.gasUsed),
          status: receipt.status === "0x1" ? "ok" : "reverted",
          logs: receipt.logs,
          hash,
        };
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no receipt for ${hash}`);
  };

  // ── faucet mint (acc0 → acc1) + max approval (acc1 → portal) ───────────────
  const mintAmount = BigInt(
    (await call(handler, FeeAssetHandlerAbi as never, "mintAmount")) as bigint | number,
  );
  console.error(`handler mintAmount = ${mintAmount}`);
  let nonce0 = Number(await rpc("eth_getTransactionCount", [acc0.address, "pending"]));
  const mintRes = await sendTx(
    acc0,
    nonce0++,
    handler,
    encodeFunctionData({
      abi: FeeAssetHandlerAbi,
      functionName: "mint",
      args: [acc1.address],
    } as never),
    300_000n,
  );
  if (mintRes.status !== "ok") throw new Error("faucet mint failed");
  const balance = BigInt(
    (await call(token, TestERC20Abi as never, "balanceOf", [acc1.address])) as bigint | number,
  );
  console.error(`acc1 FJ balance = ${balance}`);
  if (balance < BigInt(MAX_INSERTS)) throw new Error("faucet mint too small for 1-wei deposits");

  let nonce1 = Number(await rpc("eth_getTransactionCount", [acc1.address, "pending"]));
  const approveRes = await sendTx(
    acc1,
    nonce1++,
    token,
    encodeFunctionData({
      abi: TestERC20Abi,
      functionName: "approve",
      args: [portal, (1n << 256n) - 1n],
    } as never),
    100_000n,
  );
  if (approveRes.status !== "ok") throw new Error("approve failed");

  // ── deposit machinery (1 wei per deposit, constant calldata shape) ─────────
  const RECIPIENT = padHex("0x1122", { size: 32 }); // arbitrary valid bytes32, constant
  let seq = 0;
  const records: InsertRecord[] = [];

  const depositData = (): Hex =>
    encodeFunctionData({
      abi: FeeJuicePortalAbi,
      functionName: "depositToAztecPublic",
      // secretHash: small distinct field element, constant calldata gas shape
      args: [RECIPIENT, 1n, padHex(`0x${(++seq).toString(16)}`, { size: 32 })],
    } as never);

  const estimateDeposit = async (data: Hex): Promise<bigint> =>
    BigInt((await rpc("eth_estimateGas", [{ from: acc1.address, to: portal, data }])) as Hex);

  /** One deposit from acc1. Decodes DepositToAztecPublic for the leaf index. */
  const deposit = async (
    phase: string,
    opts: { estimate?: boolean; gasLimit?: bigint },
  ): Promise<InsertRecord> => {
    if (records.length >= MAX_INSERTS) throw new Error("MAX_INSERTS safety cap hit");
    const data = depositData();
    const estimate = opts.estimate ? await estimateDeposit(data) : undefined;
    const gasLimit = opts.gasLimit ?? GENEROUS_GAS;
    const res = await sendTx(acc1, nonce1++, portal, data, gasLimit);
    let globalIndex = -1n;
    for (const log of res.logs as { address: string; topics: Hex[]; data: Hex }[]) {
      if (log.address.toLowerCase() !== portal.toLowerCase()) continue;
      const ev = decodeEventLog({
        abi: FeeJuicePortalAbi,
        data: log.data,
        topics: log.topics,
      } as never) as unknown as { eventName: string; args: { index: bigint } };
      if (ev.eventName === "DepositToAztecPublic") globalIndex = ev.args.index;
    }
    const local = globalIndex >= 0n ? globalIndex % TREE_SIZE : -1n;
    const rec: InsertRecord = {
      seq,
      phase,
      globalIndex: globalIndex.toString(),
      local: Number(local),
      level: local >= 0n ? trailingOnes(local) : -1,
      estimate: estimate?.toString(),
      gasLimit: gasLimit.toString(),
      gasUsed: res.gasUsed.toString(),
      status: res.status,
      txHash: res.hash,
    };
    records.push(rec);
    return rec;
  };

  /** Insert (with generous gas) until the NEXT insert would land at `targetLocal`. */
  const fillToLocal = async (phase: string, targetLocal: bigint, estimate: boolean) => {
    for (;;) {
      const { nextIndex } = await readInboxPos();
      if (nextIndex === targetLocal) return;
      const rec = await deposit(phase, { estimate });
      if (rec.status !== "ok") throw new Error(`${phase}: fill insert reverted: ${rec.txHash}`);
      if (records.length % 128 === 0) {
        console.error(
          `[${phase}] ${records.length} inserts, at local ${rec.local} (level ${rec.level}), gasUsed ${rec.gasUsed}`,
        );
      }
    }
  };

  const startPos = await readInboxPos();
  console.error(
    `starting position: checkpoint ${startPos.checkpoint}, in-tree nextIndex ${startPos.nextIndex}`,
  );

  let failure: unknown;
  const summary: Record<string, unknown> = { startPos: { ...startPos, checkpoint: startPos.checkpoint.toString(), nextIndex: startPos.nextIndex.toString() } };
  let proxy: Server | undefined;

  try {
    // ── phase A: survey a full tree, fresh estimate before every insert ──────
    console.error("\n=== phase A: survey (fill current tree to local 1023, estimates on) ===");
    for (;;) {
      const rec = await deposit("A-survey", { estimate: true });
      if (rec.status !== "ok") throw new Error(`survey insert reverted: ${rec.txHash}`);
      if (rec.local === Number(TREE_SIZE - 1n)) break; // completed the tree
    }
    const survey = records.filter((r) => r.phase === "A-survey");
    const estimates = survey.map((r) => BigInt(r.estimate!));
    const minEstimate = estimates.reduce((a, b) => (b < a ? b : a));
    const maxEstimate = estimates.reduce((a, b) => (b > a ? b : a));
    const gasUseds = survey.map((r) => BigInt(r.gasUsed));
    const maxGasUsed = gasUseds.reduce((a, b) => (b > a ? b : a));
    console.error(
      `survey: ${survey.length} inserts; estimate min=${minEstimate} max=${maxEstimate}; gasUsed max=${maxGasUsed}`,
    );
    summary.survey = {
      inserts: survey.length,
      minEstimate: minEstimate.toString(),
      maxEstimate: maxEstimate.toString(),
      maxGasUsed: maxGasUsed.toString(),
    };

    // ── phase B: fill next tree to local 1022 ────────────────────────────────
    console.error("\n=== phase B: fill next tree to local 1022 ===");
    await fillToLocal("B-fill", TREE_SIZE - 1n, false);

    // ── phase C: worst-case insert with stale cheap 1.0x estimate → expect OOG
    console.error("\n=== phase C: deliberate failure at local 1023 with gasLimit = min estimate ===");
    const freshEstimateAtBoundary = await estimateDeposit(depositData());
    console.error(
      `fresh estimate AT the boundary: ${freshEstimateAtBoundary} (vs stale cheap ${minEstimate})`,
    );
    const victim = await deposit("C-victim-1.0x-stale", { gasLimit: minEstimate });
    console.error(
      `victim: status=${victim.status} gasLimit=${victim.gasLimit} gasUsed=${victim.gasUsed}`,
    );
    const posAfterVictim = await readInboxPos();
    console.error(
      `inbox position after victim: checkpoint ${posAfterVictim.checkpoint}, nextIndex ${posAfterVictim.nextIndex} (unchanged = leaf NOT consumed)`,
    );
    summary.victim = {
      ...victim,
      freshEstimateAtBoundary: freshEstimateAtBoundary.toString(),
      leafConsumed: posAfterVictim.nextIndex !== TREE_SIZE - 1n,
    };

    // ── phase D: same index, stale cheap estimate with the 2x buffer → succeed
    console.error("\n=== phase D: same index, gasLimit = 2 * stale min estimate ===");
    const stale2x = await deposit("D-2x-stale", { gasLimit: 2n * minEstimate });
    console.error(
      `stale-2x: status=${stale2x.status} local=${stale2x.local} gasLimit=${stale2x.gasLimit} gasUsed=${stale2x.gasUsed}`,
    );
    summary.stale2x = stale2x;

    // ── phase E: kit bridge path at a 9-level boundary (local 511) ───────────
    console.error("\n=== phase E: fill to local 510, then kit bridgeFeeJuice at local 511 ===");
    await fillToLocal("E-fill", TREE_SIZE / 2n - 1n, false);
    const { url: proxyUrl, server } = await startProxy(l1RpcUrl);
    proxy = server;
    const recipient = await AztecAddress.random();
    const { claim } = await bridgeFeeJuice({
      node,
      l1RpcUrl: proxyUrl,
      l1ChainId,
      recipient,
      l1PrivateKey: ACC0_KEY,
    });
    const kitGlobal = BigInt(String(claim.messageLeafIndex));
    const kitSend = proxyRecords.find(
      (r) => r.kind === "send" && r.to === portal.toLowerCase(),
    );
    const kitEstimates = proxyRecords.filter(
      (r) => r.kind === "estimate" && r.to === portal.toLowerCase(),
    );
    const kitEstimate = kitEstimates.at(-1)?.value;
    const kitReceipt = kitSend?.hash
      ? ((await rpc("eth_getTransactionReceipt", [kitSend.hash])) as {
          gasUsed: Hex;
          status: Hex;
        })
      : undefined;
    const kit = {
      globalIndex: kitGlobal.toString(),
      local: Number(kitGlobal % TREE_SIZE),
      level: trailingOnes(kitGlobal % TREE_SIZE),
      estimate: kitEstimate?.toString(),
      gasLimit: kitSend?.value.toString(),
      gasUsed: kitReceipt ? BigInt(kitReceipt.gasUsed).toString() : undefined,
      status: kitReceipt?.status === "0x1" ? "ok" : "reverted",
      txHash: kitSend?.hash,
    };
    console.error(`kit deposit:`, kit);
    summary.kit = kit;
  } catch (err) {
    failure = err;
    console.error("EXPERIMENT FAILURE:", err);
  }

  // ── analysis ────────────────────────────────────────────────────────────────
  const ok = records.filter((r) => r.status === "ok" && r.level >= 0);
  const byLevel = new Map<number, bigint[]>();
  for (const r of ok) {
    const arr = byLevel.get(r.level) ?? [];
    arr.push(BigInt(r.gasUsed));
    byLevel.set(r.level, arr);
  }
  const levelTable = [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, arr]) => {
      arr.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return {
        level,
        count: arr.length,
        min: arr[0].toString(),
        median: arr[Math.floor(arr.length / 2)].toString(),
        max: arr[arr.length - 1].toString(),
      };
    });
  console.log("\n=== gasUsed by cascade level (trailingOnes(local index)) ===");
  console.table(levelTable);

  const allUsed = ok.map((r) => BigInt(r.gasUsed)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const surveyEst = records
    .filter((r) => r.estimate !== undefined)
    .map((r) => BigInt(r.estimate!));
  const minEst = surveyEst.length ? surveyEst.reduce((a, b) => (b < a ? b : a)) : 0n;
  const maxUsed = allUsed.at(-1) ?? 0n;
  const headline = {
    totalSuccessfulInserts: allUsed.length,
    minGasUsed: allUsed[0]?.toString(),
    medianGasUsed: allUsed[Math.floor(allUsed.length / 2)]?.toString(),
    maxGasUsed: maxUsed.toString(),
    minEstimate: minEst.toString(),
    staleWorstCaseLimit_2xMinEstimate: (2n * minEst).toString(),
    margin: (2n * minEst - maxUsed).toString(),
  };
  console.log("\n=== headline ===");
  console.table([headline]);
  summary.levelTable = levelTable;
  summary.headline = headline;

  const outPath =
    process.env.RESULTS_JSON ?? "/tmp/test-worstcase-inbox-results.json";
  writeFileSync(outPath, JSON.stringify({ summary, records }, null, 2));
  console.log(`results written to ${outPath}`);

  proxy?.close();
  await net.stop();
  process.exit(failure ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
