/**
 * Deploy a SubscriptionFPC and fund it on L2 — on the declarative deploy framework
 * (`@aztec-kit/common/deploy`).
 *
 * Expects:
 *   --network <network>
 *   FPC_ADMIN_SECRET — FPC admin secret. The admin is an initializerless account (no
 *                      account-deploy tx); it deploys + owns the FPC. Random if unset; the
 *                      generated secret + admin address are printed back on stdout.
 *   SALT             — universal contract/account salt (default 0).
 *
 * Stdout (so callers can `eval $(... | grep ^export)`):
 *   export FPC_ADDRESS=0x…
 *   export FPC_SALT=0x…
 *
 * Side output: apps/fpc-operator/backups/<network>.fpc-admin.json (git-ignored), in the
 * fpc-operator UI's import format — merged so `register-fpc-signups` can layer on the `apps`.
 */
import { SubscriptionFPCContract } from "@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC";
import { runNetworkDeployment } from "@aztec-kit/common/deploy";
import type { FeePolicy } from "@aztec-kit/common/deploy";
import {
  parseNetwork,
  parsePaymentMode,
  loadOrCreateSecret,
  getSalt,
  writeFpcAdminBackup,
  resolveFpcAdminBackupPath,
  type PaymentMode,
} from "@aztec-kit/common/testing";

const FUND_AMOUNT: bigint = 1000n * 10n ** 18n; // 1000 FJ

/**
 * Builds the {@link FeePolicy} for a resolved payment mode. `sponsoredfpc` → a SponsoredFPC pays;
 * `feejuice` → the admin pays from its own Fee Juice, bridging from L1 if low. The L1 funder key /
 * RPC come from the env here (the framework never reads it itself); both are optional in the policy.
 */
function forcePaymentMode(paymentMode: PaymentMode): FeePolicy {
  if (paymentMode === "sponsoredfpc") return { kind: "sponsored" };
  return {
    kind: "fee-juice",
    threshold: 100n * 10n ** 18n,
    fundAmount: FUND_AMOUNT,
    l1FunderKey: process.env.L1_FUNDER_KEY as `0x${string}` | undefined,
    l1RpcUrl: process.env.L1_RPC_URL,
  };
}

async function main() {
  const network = parseNetwork();
  const paymentMode = parsePaymentMode(network);
  // The FPC admin is an initializerless account (no account-deploy step); deploying the FPC from
  // it establishes it. Generate the secret if unset and echo it back for the orchestrator.
  const fpcAdminSecret = loadOrCreateSecret("FPC_ADMIN_SECRET");
  const fpcSalt = getSalt();

  await runNetworkDeployment({
    network,
    salt: getSalt(),
    accounts: { admin: { secret: fpcAdminSecret.secretKey } },
    fees: forcePaymentMode(paymentMode),

    steps: {
      fpc: {
        kind: "contract",
        contract: SubscriptionFPCContract,
        deployer: (resolve) => resolve.account("admin"),
        initializerArgs: (resolve) => [resolve.account("admin")],
        salt: fpcSalt,
        mode: "publish",
      },

      // Fund the FPC so it can sponsor calls. The framework bridges FJ from L1, persists the
      // claim (so a crash between bridge and claim resumes instead of stranding the funds), and
      // sends the L2 claim tx from the admin. Idempotent — skipped once the FPC holds Fee Juice.
      fundFpc: {
        kind: "fund",
        recipient: (resolve) => resolve.contract("fpc"),
        threshold: 1n,
        amount: FUND_AMOUNT,
        from: (resolve) => resolve.account("admin"),
        dependsOn: ["fpc"],
      },
    },

    output: (ctx) => {
      const fpcAddress = ctx.contract("fpc");
      const admin = ctx.account("admin");

      // Write the local backup in the fpc-operator UI's import format. Merges with any existing
      // file so re-runs preserve the `apps` section `register-fpc-signups` lays down afterwards.
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
          salt: fpcSalt.toString(),
          deployed: true,
        },
      });
      console.error(`Wrote backup to ${backupPath}`);

      if (fpcAdminSecret.generated) {
        console.log(`export FPC_ADMIN_SECRET=${fpcAdminSecret.secretKey.toString()}`);
      }
      console.log(`export FPC_ADMIN_ADDRESS=${admin.toString()}`);
      console.log(`export FPC_ADDRESS=${fpcAddress.toString()}`);
      console.log(`export FPC_SALT=${fpcSalt.toString()}`);
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
