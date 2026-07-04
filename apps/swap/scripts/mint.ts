/**
 * Mint tokens to one or more addresses on an existing deployment.
 *
 * Usage:
 *   SWAP_ADMIN_SECRET=0x... node --experimental-transform-types scripts/mint.ts --network <network> --to 0xaddr1 --to 0xaddr2
 *   SWAP_ADMIN_SECRET=0x... MINT_TO=0xaddr1,0xaddr2 node --experimental-transform-types scripts/mint.ts --network <network>
 *
 * Requires SWAP_ADMIN_SECRET env var to reconstruct the deployer account (must match the original deployer).
 */

import fs from "fs";
import path from "path";
import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { TokenContract, TokenContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/Token";
import { BatchCall } from "@aztec/aztec.js/contracts";
import {
  parseNetwork,
  parseAddressList,
  NETWORK_URLS,
  setupWallet,
  loadOrCreateSecret,
  getAdmin,
} from "@aztec-kit/common/testing";

const NETWORK = parseNetwork();
const MINT_TO = parseAddressList("--to", "MINT_TO");

if (MINT_TO.length === 0) {
  console.error("No addresses to mint to. Use --to <address> or MINT_TO env var.");
  process.exit(1);
}

if (!process.env.SWAP_ADMIN_SECRET) {
  console.error("SWAP_ADMIN_SECRET env var is required to reconstruct the deployer account.");
  process.exit(1);
}

const AMOUNT = process.env.AMOUNT ? BigInt(process.env.AMOUNT) : 1_000_000_000n;

// Load network config to get contract addresses
const configPath = path.join(import.meta.dirname, `../src/config/networks/${NETWORK}.json`);
if (!fs.existsSync(configPath)) {
  console.error(`Network config not found: ${configPath}. Run deploy first.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

async function main() {
  const nodeUrl = NETWORK_URLS[NETWORK];
  const { node, wallet, paymentMethod } = await setupWallet(nodeUrl, NETWORK);

  console.log("Reconstructing deployer account...");
  const { secretKey } = loadOrCreateSecret("SWAP_ADMIN_SECRET");
  const deployer = await getAdmin(wallet, secretKey, Fr.fromString(config.contracts.salt));
  console.log(`Deployer: ${deployer.toString()}`);

  // Register token contracts
  const goCoinAddress = AztecAddress.fromStringUnsafe(config.contracts.goCoin);
  const goCoinPremiumAddress = AztecAddress.fromStringUnsafe(config.contracts.goCoinPremium);

  const [goCoinInstance, goCoinPremiumInstance] = await Promise.all([
    wallet.getContractMetadata(goCoinAddress).then((m) => m.instance),
    wallet.getContractMetadata(goCoinPremiumAddress).then((m) => m.instance),
  ]);

  // Register if not already registered
  if (!goCoinInstance) {
    const instance = await node.getContract(goCoinAddress);
    await wallet.registerContract(instance!, TokenContractArtifact);
  }
  if (!goCoinPremiumInstance) {
    const instance = await node.getContract(goCoinPremiumAddress);
    await wallet.registerContract(instance!, TokenContractArtifact);
  }

  const goCoin = TokenContract.at(goCoinAddress, wallet);
  const goCoinPremium = TokenContract.at(goCoinPremiumAddress, wallet);

  // Build mint calls
  const mintCalls = MINT_TO.flatMap((addr) => {
    const recipient = AztecAddress.fromStringUnsafe(addr);
    console.log(`Will mint ${AMOUNT} GoCoin + GoCoinPremium to ${addr}`);
    return [
      goCoin.methods.mint_to_private(recipient, AMOUNT),
      goCoinPremium.methods.mint_to_private(recipient, AMOUNT),
    ];
  });

  console.log(`Sending batch mint tx (${mintCalls.length} calls)...`);
  await new BatchCall(wallet, mintCalls).send({
    from: deployer,
    fee: { paymentMethod },
    wait: { timeout: 120 },
  });

  console.log("Done! Tokens minted successfully.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
