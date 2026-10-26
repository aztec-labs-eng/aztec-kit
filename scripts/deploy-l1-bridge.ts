/**
 * CLI wrapper around `deployL1Bridge` from `@aztec-kit/contracts-ethereum`.
 *
 * Usage:
 *   DEPLOYER_KEY=0x… node scripts/deploy-l1-bridge.ts [chain]
 *
 * Args:
 *   chain — "sepolia" (default), "mainnet", "anvil"
 *
 * Env:
 *   DEPLOYER_KEY — hex private key for the L1 deployer (not required for anvil).
 *   RPC_URL      — override the default RPC endpoint.
 */
import type { Hex } from "viem";
import { deployL1Bridge, type ChainName } from "@aztec-kit/contracts-ethereum";

const VALID: ChainName[] = ["sepolia", "mainnet", "anvil"];

async function main() {
  const chainName = (process.argv[2] ?? "sepolia").toLowerCase() as ChainName;
  if (!VALID.includes(chainName)) {
    console.error(`Unknown chain: ${chainName}. Valid: ${VALID.join(", ")}`);
    process.exit(1);
  }

  const deployerKey = process.env.DEPLOYER_KEY as Hex | undefined;
  const rpcUrl = process.env.RPC_URL;

  const address = await deployL1Bridge({ chainName, rpcUrl, deployerKey });
  console.error(`Bridge on ${chainName}: ${address}`);
  console.log(address);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
