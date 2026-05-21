/**
 * Initializerless Schnorr Account
 *
 * An account contract that doesn't require deployment/initialization.
 * The signing key is committed via the contract salt using the immutables pattern.
 * This means the account can sign and send transactions immediately after PXE
 * registration — no on-chain deployment needed.
 */

import {
  type Account,
  type AccountContract,
  type AuthWitnessProvider,
  BaseAccount,
} from "@aztec/aztec.js/account";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import { CompleteAddress } from "@aztec/stdlib/contract";
import { DefaultAccountEntrypoint } from "@aztec/entrypoints/account";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { AuthWitness } from "@aztec/stdlib/auth-witness";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { deriveSigningKey } from "@aztec/stdlib/keys";

import * as immutables from "./immutables";

async function loadArtifact() {
  const { SchnorrInitializerlessAccountContractArtifact } =
    await import("@aztec-kit/contracts-aztec/artifacts/SchnorrInitializerlessAccount");
  return SchnorrInitializerlessAccountContractArtifact;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SigningPublicKey {
  x: Fr;
  y: Fr;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export async function serializeSigningKey(key: SigningPublicKey): Promise<Fr[]> {
  const artifact = await loadArtifact();
  return immutables.serializeFromLayout(artifact, {
    public_key: [key.x, key.y],
  });
}

export async function computeContractSalt(actualSalt: Fr, key: SigningPublicKey): Promise<Fr> {
  return immutables.computeContractSalt(actualSalt, await serializeSigningKey(key));
}

export async function createSigningKeyCapsule(
  contractAddress: AztecAddress,
  actualSalt: Fr,
  key: SigningPublicKey,
) {
  return immutables.createImmutablesCapsule(
    contractAddress,
    actualSalt,
    await serializeSigningKey(key),
  );
}

// ---------------------------------------------------------------------------
// AccountContract implementation
// ---------------------------------------------------------------------------

export class SchnorrInitializerlessAccount implements AccountContract {
  constructor(
    private signingPrivateKey: GrumpkinScalar,
    private signingPublicKey: SigningPublicKey,
  ) {}

  async getInitializationFunctionAndArgs(): Promise<undefined> {
    return undefined;
  }

  async getContractArtifact(): Promise<ContractArtifact> {
    return loadArtifact();
  }

  getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    return new SchnorrInitializerlessAuthWitnessProvider(this.signingPrivateKey);
  }

  getAccount(completeAddress: CompleteAddress): Account {
    const authWitnessProvider = this.getAuthWitnessProvider(completeAddress);
    return new BaseAccount(
      new DefaultAccountEntrypoint(completeAddress.address, authWitnessProvider),
      authWitnessProvider,
      completeAddress,
    );
  }

  getSigningPublicKey(): SigningPublicKey {
    return this.signingPublicKey;
  }
}

// ---------------------------------------------------------------------------
// AuthWitnessProvider
// ---------------------------------------------------------------------------

export class SchnorrInitializerlessAuthWitnessProvider implements AuthWitnessProvider {
  constructor(private signingPrivateKey: GrumpkinScalar) {}

  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    const schnorr = new Schnorr();
    const signature = await schnorr.constructSignature(messageHash, this.signingPrivateKey);
    return new AuthWitness(messageHash, signature.toLimbFields());
  }
}

// ---------------------------------------------------------------------------
// Factory: derive account contract + keys from a secret key
// ---------------------------------------------------------------------------

export async function createSchnorrInitializerlessAccount(secretKey: Fr): Promise<{
  account: SchnorrInitializerlessAccount;
  signingPrivateKey: GrumpkinScalar;
  signingPublicKey: SigningPublicKey;
}> {
  const signingPrivateKey = deriveSigningKey(secretKey);
  const schnorr = new Schnorr();
  const publicKeyPoint = await schnorr.computePublicKey(signingPrivateKey);

  const signingPublicKey: SigningPublicKey = {
    x: new Fr(publicKeyPoint.x.toBigInt()),
    y: new Fr(publicKeyPoint.y.toBigInt()),
  };

  const account = new SchnorrInitializerlessAccount(signingPrivateKey, signingPublicKey);

  return { account, signingPrivateKey, signingPublicKey };
}
