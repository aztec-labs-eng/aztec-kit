/**
 * Admin account handling for deploy scripts. Reproducible addresses via the
 * `SALT` env var, on-demand secret generation, and a single canonical way to
 * obtain the admin: an **initializerless** Schnorr account — immediately usable
 * with no account-deploy tx. This is the same derivation the deploy framework
 * (`../deploy/runner.ts`) uses for its deployers, so every script and the
 * framework agree on the admin's address.
 */
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/foundation/curves/bn254";

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
 * unset. Used for admin account salts, swap contract address salt, FPC
 * contract address salt — everything that needs a salt to give reproducible
 * deployments across re-runs.
 */
export function getSalt(): Fr {
  const env = process.env.SALT;
  return env ? Fr.fromString(env) : new Fr(0);
}

/**
 * Derives the admin's **initializerless** Schnorr account and returns its L2
 * address. Initializerless accounts need no deploy tx — the address is usable
 * immediately (it can send txs, paying via a SponsoredFPC, its own Fee Juice
 * balance, or a bridge claim). Registers the account in the wallet (PXE) as a
 * side effect so the caller can sign from it.
 *
 * Reconstructs the signing account from the canonical credential (`secretKey`); the address is a
 * pure function of (`secretKey`, `salt`). The caller passes the `salt` from the single source for
 * this run — the deployment manifest or a forwarded handoff — NOT an ambient {@link getSalt} read,
 * so the address matches what the deploy framework resolved by construction rather than by
 * coincidence.
 */
export async function getAdmin(
  wallet: EmbeddedWallet,
  secretKey: Fr,
  salt: Fr,
): Promise<AztecAddress> {
  const account = await wallet.createSchnorrInitializerlessAccount(
    secretKey,
    salt,
    deriveSigningKey(secretKey),
  );
  return account.address;
}
