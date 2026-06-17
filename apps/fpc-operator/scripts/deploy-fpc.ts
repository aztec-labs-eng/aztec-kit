/**
 * Deploys (or re-registers, if already deployed) a SubscriptionFPC and funds
 * it on L2 via the bridge.
 *
 * Expects:
 *   --network <network>
 *   FPC_ADMIN_SECRET — FPC admin secret (from `deploy-admin`).
 *   FPC_SECRET       — FPC contract key secret. When provided AND the derived
 *                      contract is already on-chain, deploy is skipped.
 *                      Random if unset; printed back on stdout.
 *   SALT             — universal contract/account salt (default 0).
 *
 * Stdout (structured so callers can `eval $(... | grep ^export)`):
 *   export FPC_ADDRESS=0x…
 *   export FPC_SECRET=0x…
 *
 * Side output:
 *   apps/fpc-operator/backups/<network>.fpc-admin.json — contains the admin
 *   secret key, salt, FPC secret key, salt, and address. Git-ignored.
 */
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { bridgeAndClaim } from "@aztec-kit/common/bridging";
import { SubscriptionFPC } from "@aztec-kit/contracts-aztec/subscription-fpc";
import { SubscriptionFPCContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC";
import {
  parseNetwork,
  NETWORK_URLS,
  L1_DEFAULTS,
  resolveL1Funder,
  bridgeMode,
  setupWallet,
  loadOrCreateSecret,
  getAdmin,
  getSalt,
  writeFpcAdminBackup,
  resolveFpcAdminBackupPath,
} from "@aztec-kit/common/testing";
import { deriveKeys } from "@aztec/stdlib/keys";

const FUND_AMOUNT: bigint = BigInt("1000000000000000000000"); // 1000 FJ

async function main() {
  const network = parseNetwork();
  const fpcAdminSecret = loadOrCreateSecret("FPC_ADMIN_SECRET");
  if (fpcAdminSecret.generated) {
    console.error(
      "FPC_ADMIN_SECRET not set — refusing to generate one here. Run `deploy-admin` first.",
    );
    process.exit(1);
  }

  // FPC contract key secret (the "not actually secret" FPC key used so the FPC
  // can own private notes for its slot tracking). Deterministic if caller provides.
  const fpcSecret = loadOrCreateSecret("FPC_SECRET");
  const fpcSalt = getSalt();

  const { node, wallet, paymentMethod } = await setupWallet(NETWORK_URLS[network], network);
  const admin = await getAdmin(
    wallet,
    fpcAdminSecret.secretKey,
    `Run \`yarn fpc-operator deploy-admin:${network}\` first.`,
  );
  console.error(`FPC admin: ${admin.toString()}`);

  // Compute the FPC's deterministic address up front so we can detect the
  // already-deployed case and skip re-deploying.
  const { publicKeys } = await deriveKeys(fpcSecret.secretKey);
  const deployMethod = await SubscriptionFPC.deploy(wallet, admin, {
    salt: fpcSalt,
    deployer: admin,
    publicKeys,
  });
  const instance = await deployMethod.getInstance();
  const fpcAddress: AztecAddress = instance.address;

  const existing = await node.getContract(fpcAddress);
  if (existing) {
    // Already on-chain — just register it in the PXE so downstream steps can
    // interact. Skip both the deploy tx and the L1 bridge + claim.
    await wallet.registerContract(instance, SubscriptionFPCContractArtifact, fpcSecret.secretKey);
    console.error(`FPC already deployed at ${fpcAddress.toString()} — reusing.`);
  } else {
    console.error("Deploying SubscriptionFPC...");
    await wallet.registerContract(instance, SubscriptionFPCContractArtifact, fpcSecret.secretKey);
    await deployMethod.send({
      from: admin,
      fee: { paymentMethod },
      wait: { timeout: 120 },
    });
    console.error(`FPC deployed at ${fpcAddress.toString()}`);

    // Bridge FJ to the freshly-deployed FPC so it can pay for sponsored calls.
    console.error(`Bridging FJ to FPC...`);
    const { amount, minted } = await bridgeAndClaim({
      node,
      wallet,
      recipient: fpcAddress,
      claimFrom: admin,
      claimFeeOpts: { paymentMethod },
      l1RpcUrl: L1_DEFAULTS[network].l1RpcUrl,
      l1ChainId: L1_DEFAULTS[network].l1ChainId,
      amount: FUND_AMOUNT,
      l1PrivateKey: resolveL1Funder(network),
      mode: bridgeMode(network),
    });
    console.error(`Bridged ${amount} FJ to FPC (minted=${minted}).`);
  }

  // Write the local backup file in the fpc-operator UI's import format.
  // Merges with any existing file so re-runs preserve the `apps` section
  // that `register-fpc-signups` lays down afterwards.
  const backupPath = resolveFpcAdminBackupPath(network, import.meta.dirname);
  writeFpcAdminBackup({
    backupPath,
    network,
    admin: {
      secretKey: fpcAdminSecret.secretKey.toString(),
      salt: getSalt().toString(),
      address: admin.toString(),
    },
    fpc: {
      address: fpcAddress.toString(),
      secretKey: fpcSecret.secretKey.toString(),
      salt: fpcSalt.toString(),
      deployed: true,
    },
  });
  console.error(`Wrote backup to ${backupPath}`);

  // Stdout contract: exportable env lines for the orchestrator.
  console.log(`export FPC_ADDRESS=${fpcAddress.toString()}`);
  console.log(`export FPC_SECRET=${fpcSecret.secretKey.toString()}`);
  console.log(`export FPC_SALT=${fpcSalt.toString()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
