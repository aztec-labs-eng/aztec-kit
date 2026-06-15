/**
 * Deploys the swap admin schnorr account, generating a fresh secret if the
 * caller didn't supply one.
 *
 * Deploy method is auto-detected:
 *   - admin already holds public FJ on L2 → use it (`FeeJuicePaymentMethod`).
 *   - otherwise on the local sandbox       → SponsoredFPC pays.
 *   - otherwise on a remote network        → bridge + claim via `FeeJuicePaymentMethodWithClaim`.
 *
 * Usage:
 *   yarn swap deploy-admin --network <network>
 *
 * Env vars:
 *   SWAP_ADMIN_SECRET — hex Fr for the admin secret. If unset, a new key is
 *                       generated and the script prints an `export SWAP_ADMIN_SECRET=…`
 *                       line on stdout before exiting.
 *   L1_FUNDER_KEY     — remote networks only. L1 private key holding FJ. When unset,
 *                       a random L1 key is generated and the faucet mints FJ.
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
  const { secretKey, generated } = loadOrCreateSecret("SWAP_ADMIN_SECRET");

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
    label: "Swap admin",
  });

  if (generated) {
    console.log(`export SWAP_ADMIN_SECRET=${secretKey.toString()}`);
  }
  console.log(`export SWAP_ADMIN_ADDRESS=${adminAddress.toString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
