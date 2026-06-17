/**
 * Mirrors apps/swap/scripts/deploy-admin.ts but for the FPC admin.
 *
 * Deploy method is auto-detected: pre-funded FJ → use it; otherwise
 * SponsoredFPC on the local network, bridge + claim on remote networks. See
 * `deployAdmin` in `@aztec-kit/common/testing` for the full decision tree.
 */
import {
  parseNetwork,
  NETWORK_URLS,
  setupWallet,
  loadOrCreateSecret,
  deployAdmin,
} from "@aztec-kit/common/testing";

async function main() {
  const network = parseNetwork();
  const { secretKey, generated } = loadOrCreateSecret("FPC_ADMIN_SECRET");

  const {
    node,
    wallet,
    paymentMethod: sponsoredPaymentMethod,
  } = await setupWallet(
    NETWORK_URLS[network],
    network,
    network === "local" ? "sponsoredfpc" : "feejuice",
  );

  const adminAddress = await deployAdmin({
    network,
    node,
    wallet,
    secretKey,
    sponsoredPaymentMethod,
    label: "FPC admin",
  });

  if (generated) {
    console.log(`export FPC_ADMIN_SECRET=${secretKey.toString()}`);
  }
  console.log(`export FPC_ADMIN_ADDRESS=${adminAddress.toString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
