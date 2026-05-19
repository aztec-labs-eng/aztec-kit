/**
 * Lower-level bridging primitives used to build the public `bridge` /
 * `bridgeAndClaim` flows in `./index.ts`. Not intended for direct use by
 * scripts — the flow helpers wrap these with the right arguments.
 *
 * Node-only: pulls in `@aztec/aztec.js/ethereum` + viem and relies on
 * `process.env`.
 */
import type { AztecNode } from "@aztec/aztec.js/node";
import type { AztecNodeDebug } from "@aztec/stdlib/interfaces/client";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { L1FeeJuicePortalManager } from "@aztec/aztec.js/ethereum";
import { isL1ToL2MessageReady } from "@aztec/aztec.js/messaging";
import { createExtendedL1Client } from "@aztec/ethereum/client";
import { createEthereumChain } from "@aztec/ethereum/chain";
import { createLogger } from "@aztec/foundation/log";
import { DateProvider } from "@aztec/foundation/timer";
import { Fr } from "@aztec/foundation/curves/bn254";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "viem";

const POLL_INTERVAL_MS = 1000;
const WARP_BY_SECONDS = 36n; // roughly one L2 slot

export interface BridgeFeeJuiceParams {
  node: AztecNode;
  l1RpcUrl: string;
  l1ChainId: number;
  /** Aztec recipient. */
  recipient: AztecAddress;
  /**
   * Desired amount in wei to bridge. Used only on the non-faucet path; when
   * the faucet path kicks in, the handler's `mintAmount()` is authoritative.
   */
  amount?: bigint;
  /**
   * L1 private key to sign the bridge tx. When omitted, a fresh ephemeral
   * key is generated — only useful when the faucet handler is present.
   */
  l1PrivateKey?: Hex;
}

export interface BridgeFeeJuiceResult {
  /** Full claim credentials returned by `L1FeeJuicePortalManager.bridgeTokensPublic`. */
  claim: Awaited<ReturnType<L1FeeJuicePortalManager["bridgeTokensPublic"]>>;
  /** The L1 address that actually paid for the tx — useful for logging. */
  l1Address: string;
  /** Whether the faucet/mint path was used. */
  minted: boolean;
}

/**
 * Bridges fee juice to an L2 recipient. Mirrors the bridge UI's decision:
 *   - faucet handler exists AND L1 signer has no FJ → mint via the handler
 *   - otherwise → transfer the caller's existing FJ balance to the portal
 *
 * Throws only if neither path is viable (handler missing AND signer has no FJ,
 * or non-faucet path requested with no `amount` specified).
 */
export async function bridgeFeeJuice(params: BridgeFeeJuiceParams): Promise<BridgeFeeJuiceResult> {
  const { node, l1RpcUrl, l1ChainId, recipient } = params;

  const l1PrivateKey: Hex = params.l1PrivateKey ?? generatePrivateKey();
  const chain = createEthereumChain([l1RpcUrl], l1ChainId);
  const l1Client = createExtendedL1Client(chain.rpcUrls, l1PrivateKey, chain.chainInfo);
  const portalManager = await L1FeeJuicePortalManager.new(node, l1Client, createLogger("bridging"));

  const tokenManager = portalManager.getTokenManager();
  const hasFaucet = tokenManager.handlerAddress !== undefined;
  const signerAddress = l1Client.account.address;
  const l1Balance = await tokenManager.getL1TokenBalance(signerAddress);

  // Mint via the faucet unless the signer already holds "enough" FJ. 10 FJ is
  // plenty for any single bridge we do here (admin funding tops out at 1000,
  // but the usual case is «signer has dust from a previous run» which used
  // to trip the `=== 0n` check and skip minting, causing ERC20InsufficientBalance.
  const FAUCET_SKIP_THRESHOLD = 10n * 10n ** 18n;
  const minted = hasFaucet && l1Balance < FAUCET_SKIP_THRESHOLD;
  if (!minted && !hasFaucet && l1Balance < FAUCET_SKIP_THRESHOLD) {
    throw new Error(
      `L1 signer ${signerAddress} holds ${l1Balance} FJ (below threshold) and no fee-asset handler is available for minting.`,
    );
  }

  let amountArg: bigint | undefined;
  if (minted) {
    amountArg = undefined;
  } else {
    if (params.amount === undefined) {
      throw new Error(
        `bridgeFeeJuice: \`amount\` is required when the faucet path is not used (L1 signer holds ${l1Balance} FJ).`,
      );
    }
    amountArg = params.amount;
  }

  const claim = await portalManager.bridgeTokensPublic(recipient, amountArg, minted);
  return { claim, l1Address: signerAddress, minted };
}

export interface WaitForClaimParams {
  node: AztecNode;
  messageHash: Fr;
  /**
   * On `local` we can't rely on the sequencer to mine blocks, so we advance L1
   * + L2 time via admin RPCs until the message shows as available.
   * On every other network we just poll.
   */
  mode: "warp" | "poll";
  /** How long to wait before giving up (default 30 minutes for poll, 2 minutes for warp). */
  timeoutMs?: number;
  /** Local-only overrides for the warp cheat codes. */
  warpOpts?: { nodeUrl?: string; l1RpcUrl?: string };
}

/**
 * Waits until an L1→L2 message is available on the node. In `warp` mode it
 * actively pushes time forward via the local-network debug RPCs. In `poll`
 * mode it just checks periodically.
 */
export async function waitForL1ToL2Message(params: WaitForClaimParams): Promise<void> {
  const { node, messageHash, mode } = params;

  if (mode === "warp") {
    await advanceL1ToL2Message(node, messageHash, {
      ...params.warpOpts,
      timeoutMs: params.timeoutMs ?? 120_000,
    });
    return;
  }

  const startedAt = Date.now();
  const timeoutMs = params.timeoutMs ?? 30 * 60_000;
  const deadline = startedAt + timeoutMs;
  console.error(
    `Waiting for L1→L2 message ${messageHash.toString()} (up to ${Math.round(timeoutMs / 60_000)} min)...`,
  );
  let lastLog = startedAt;
  while (Date.now() < deadline) {
    if (await isL1ToL2MessageReady(node, messageHash)) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.error(`  L1→L2 message ready after ${elapsed}s.`);
      return;
    }
    if (Date.now() - lastLog > 30_000) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.error(`  still waiting (${elapsed}s elapsed)...`);
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`L1→L2 message ${messageHash.toString()} did not become available in time`);
}

/**
 * Local-network helper: advances L1 + L2 time via admin RPCs until the given
 * L1→L2 message shows up as available. Relies on `nodeDebug_mineBlock` and
 * Anvil's `evm_setNextBlockTimestamp`, loaded lazily so browser-ish bundles
 * that never hit warp mode can tree-shake them out.
 */
export async function advanceL1ToL2Message(
  node: AztecNode,
  messageHash: Fr,
  opts: { nodeUrl?: string; l1RpcUrl?: string; timeoutMs?: number } = {},
): Promise<void> {
  const nodeUrl = opts.nodeUrl ?? process.env.AZTEC_NODE_URL ?? "http://localhost:8080";
  const l1RpcUrl = opts.l1RpcUrl ?? process.env.ETHEREUM_HOST ?? "http://localhost:8545";
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const [{ createAztecNodeDebugClient }, { CheatCodes }] = await Promise.all([
    import("@aztec/stdlib/interfaces/client"),
    import("@aztec/aztec/testing"),
  ]);
  const nodeDebug = createAztecNodeDebugClient(nodeUrl);
  // v5's `warpL2TimeAtLeastBy` wants `AztecNode & AztecNodeDebug` (it reads
  // the current L1 timestamp via the regular API before warping). Both
  // clients target the same URL and expose methods as own properties on the
  // rpc proxy, so a shallow merge is safe.
  const fullNode = Object.assign({}, node, nodeDebug) as AztecNode & AztecNodeDebug;
  const cheatCodes = await CheatCodes.create([l1RpcUrl], node, new DateProvider());

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isL1ToL2MessageReady(node, messageHash)) return;
    await cheatCodes.warpL2TimeAtLeastBy(fullNode, WARP_BY_SECONDS);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`L1→L2 message ${messageHash.toString()} did not become available in time`);
}
