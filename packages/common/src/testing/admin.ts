/**
 * Admin schnorr account handling for deploy scripts. Reproducible addresses
 * via `SALT` env var, on-demand secret generation, and three ways to
 * actually deploy: sponsored-FPC, bridge-and-claim, or pre-funded.
 */
import type { AztecNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/foundation/curves/bn254";
import { ContractInitializationStatus } from "@aztec/aztec.js/wallet";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { TxStatus } from "@aztec/stdlib/tx";
import { NO_FROM } from "@aztec/aztec.js/account";
import { getSchnorrAccountContractAddress } from "@aztec/accounts/schnorr";

import { bridge } from "../bridging/index.ts";
import { L1_DEFAULTS, bridgeMode, resolveL1Funder, type NetworkName } from "./network-config.ts";
import type { PaymentMethod } from "./wallet-setup.ts";

/**
 * Reads an admin secret from the named env var, generating a fresh one only
 * when absent. The caller is expected to surface the generated secret back
 * to the operator (typically as `export NAME=…` on stdout) so it can be
 * re-exported for subsequent runs.
 */
export function loadOrCreateSecret(envVar: string): { secretKey: Fr; generated: boolean } {
  const env = process.env[envVar];
  if (env) return { secretKey: Fr.fromString(env), generated: false };
  return { secretKey: Fr.random(), generated: true };
}

/**
 * Universal salt read from the `SALT` env var, defaulting to `Fr(0)` when
 * unset. Used for admin schnorr account salts, swap contract address salt,
 * FPC contract address salt — everything that needs a salt to give
 * reproducible deployments across re-runs.
 */
export function getSalt(): Fr {
  const env = process.env.SALT;
  return env ? Fr.fromString(env) : new Fr(0);
}

/**
 * Computes the deterministic L2 address of a schnorr admin account without
 * touching the chain. Uses the `SALT` env var (defaults to 0) so callers
 * that override the universal salt see the right address.
 */
export async function deriveSchnorrAdminAddress(secretKey: Fr): Promise<AztecAddress> {
  return getSchnorrAccountContractAddress(secretKey, getSalt());
}

/**
 * Registers the admin schnorr account in the wallet (PXE) and verifies it is
 * already initialised on-chain. Throws with `hint` appended to the error if
 * not — the caller typically names the script that should have run first
 * (e.g. `Run \`yarn swap deploy-admin:<network>\` first.`).
 *
 * Does **not** deploy the account — that's `deployAdmin`'s job.
 * Every other script should use this.
 */
export async function getAdmin(
  wallet: EmbeddedWallet,
  secretKey: Fr,
  hint: string,
): Promise<AztecAddress> {
  const signingKey = deriveSigningKey(secretKey);
  const accountManager = await wallet.createSchnorrAccount(secretKey, getSalt(), signingKey);

  const { initializationStatus } = await wallet.getContractMetadata(accountManager.address);
  if (initializationStatus !== ContractInitializationStatus.INITIALIZED) {
    throw new Error(
      `Admin account ${accountManager.address.toString()} is not initialised on-chain. ${hint}`,
    );
  }
  return accountManager.address;
}

/**
 * How the admin pays for its own deploy:
 * - `sponsoredfpc`: caller provides a `SponsoredFeePaymentMethod` (only viable
 *   on networks where SponsoredFPC exists — i.e. `local`).
 * - `bridge`: bridge FJ from L1 → L2 and claim + deploy in one private tx
 *   via `FeeJuicePaymentMethodWithClaim`. The canonical "cold network" flow.
 * - `prefunded`: admin address already holds public FJ on L2 (someone ran
 *   the bridge + claim externally — e.g. the bridge UI). Deploy pays from
 *   that balance via plain `FeeJuicePaymentMethod`. No bridge, no claim.
 */
export type AdminDeployMode = "sponsoredfpc" | "bridge" | "prefunded";

const DEFAULT_BRIDGE_AMOUNT: bigint = BigInt("1000000000000000000000"); // 1000 FJ

/**
 * Reads the admin's public fee-juice balance. Used by `deployAdmin` to
 * detect the `prefunded` mode — if the admin already holds FJ on L2, we
 * skip the bridge.
 */
async function getPublicFeeJuiceBalance(
  wallet: EmbeddedWallet,
  target: AztecAddress,
  from: AztecAddress,
): Promise<bigint> {
  const fj = FeeJuiceContract.at(wallet);
  const { result } = await fj.methods.balance_of_public(target).simulate({ from });
  return BigInt(result.toString());
}

export interface DeployAdminParams {
  network: NetworkName;
  node: AztecNode;
  wallet: EmbeddedWallet;
  secretKey: Fr;
  /**
   * Required when mode resolves to `sponsoredfpc`. Typically the
   * `paymentMethod` returned by `setupWallet(…, 'sponsoredfpc')`.
   */
  sponsoredPaymentMethod?: PaymentMethod;
  /**
   * Override the auto-detected mode. When unset, `deployAdmin`:
   *   1. checks if the admin is already initialised → no-op
   *   2. checks if it already holds public FJ → `prefunded`
   *   3. falls back to `sponsoredfpc` on local, `bridge` on testnet
   */
  mode?: AdminDeployMode;
  /** Label used in log lines (e.g. "Swap admin", "FPC admin"). */
  label?: string;
  /** Override the default 1000 FJ bridged when mode is `bridge`. */
  bridgeAmount?: bigint;
}

/**
 * Idempotently ensures the admin's schnorr account exists on-chain. Returns
 * its address either way.
 *
 * See `AdminDeployMode` for how the payment method is chosen. Callers should
 * pass `sponsoredPaymentMethod` from `setupWallet` when running on local; on
 * testnet the bridge path needs no extra wiring.
 */
export async function deployAdmin(params: DeployAdminParams): Promise<AztecAddress> {
  const { network, node, wallet, secretKey, sponsoredPaymentMethod, bridgeAmount } = params;
  const label = params.label ?? "Admin";

  const signingKey = deriveSigningKey(secretKey);
  const accountManager = await wallet.createSchnorrAccount(secretKey, getSalt(), signingKey);
  const adminAddress = accountManager.address;

  const { initializationStatus } = await wallet.getContractMetadata(adminAddress);
  if (initializationStatus === ContractInitializationStatus.INITIALIZED) {
    console.error(`${label} already initialised on-chain, skipping deploy.`);
    return adminAddress;
  }

  const mode = params.mode ?? (await resolveDeployMode(wallet, adminAddress, network));
  const deployMethod = await accountManager.getDeployMethod();

  if (mode === "sponsoredfpc") {
    if (!sponsoredPaymentMethod) {
      throw new Error(
        `${label}: sponsoredfpc mode requires sponsoredPaymentMethod. Pass the paymentMethod from setupWallet(…, 'sponsoredfpc').`,
      );
    }
    console.error(`Deploying ${label} via SponsoredFPC...`);
    await deployMethod.send({
      from: NO_FROM,
      fee: { paymentMethod: sponsoredPaymentMethod },
      skipClassPublication: true,
      skipInstancePublication: true,
      // Pin PROPOSED — upstream's EmbeddedWallet default-to-PROPOSED is dead
      // code (mutates a local that's never forwarded), so `waitForTx` falls
      // back to CHECKPOINTED unless we set it explicitly.
      wait: { waitForStatus: TxStatus.PROPOSED, timeout: 120 },
    });
  } else if (mode === "prefunded") {
    // Admin already holds public FJ (someone bridged + claimed externally —
    // e.g. the bridge UI in e2e). The aztec.js deploy machinery pays for
    // the init tx directly from that balance when no `fee` is provided.
    // This mirrors `@aztec/wallets/testing::deployFundedSchnorrAccounts`.
    console.error(`Deploying ${label} using existing public FJ balance...`);
    await deployMethod.send({
      from: NO_FROM,
      skipClassPublication: true,
      skipInstancePublication: true,
      // Pin PROPOSED — upstream's EmbeddedWallet default-to-PROPOSED is dead
      // code (mutates a local that's never forwarded), so `waitForTx` falls
      // back to CHECKPOINTED unless we set it explicitly.
      wait: { waitForStatus: TxStatus.PROPOSED, timeout: 120 },
    });
  } else {
    // bridge
    console.error(`Bridging FJ to ${adminAddress.toString()}...`);
    const { claim, l1Address, minted } = await bridge({
      node,
      recipient: adminAddress,
      l1RpcUrl: L1_DEFAULTS[network].l1RpcUrl,
      l1ChainId: L1_DEFAULTS[network].l1ChainId,
      amount: bridgeAmount ?? DEFAULT_BRIDGE_AMOUNT,
      l1PrivateKey: resolveL1Funder(network),
      mode: bridgeMode(network),
    });
    console.error(
      `Bridged ${claim.claimAmount} FJ from L1 address ${l1Address} (minted=${minted}).`,
    );
    await deployMethod.send({
      from: NO_FROM,
      fee: { paymentMethod: new FeeJuicePaymentMethodWithClaim(adminAddress, claim) },
      skipClassPublication: true,
      skipInstancePublication: true,
      // Pin PROPOSED — upstream's EmbeddedWallet default-to-PROPOSED is dead
      // code (mutates a local that's never forwarded), so `waitForTx` falls
      // back to CHECKPOINTED unless we set it explicitly.
      wait: { waitForStatus: TxStatus.PROPOSED, timeout: 120 },
    });
  }

  console.error(`${label} deployed.`);
  return adminAddress;
}

async function resolveDeployMode(
  wallet: EmbeddedWallet,
  adminAddress: AztecAddress,
  network: NetworkName,
): Promise<AdminDeployMode> {
  // `balance_of_public` is a read-only utility, but simulating it needs a
  // `from` that the PXE can sign for. The admin address is the cheapest
  // choice here — it's already registered via `createSchnorrAccount`.
  const balance = await getPublicFeeJuiceBalance(wallet, adminAddress, adminAddress);
  if (balance > 0n) return "prefunded";
  return network === "local" ? "sponsoredfpc" : "bridge";
}
