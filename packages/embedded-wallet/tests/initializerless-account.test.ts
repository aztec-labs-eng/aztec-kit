/**
 * E2E Tests for the Initializerless Schnorr Account
 *
 * Verifies that the AZIP-9 immutables_hash pattern works end-to-end:
 * - Account creation produces correct addresses
 * - Immutables are stored and verified against `instance.immutables_hash`
 * - The account can sign and send transactions without deployment
 * - Different keys/salts produce different addresses
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AztecNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { deployFundedSchnorrAccounts } from "@aztec/wallets/testing";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";

import {
  SchnorrInitializerlessAccountContract,
  SchnorrInitializerlessAccountContractArtifact,
} from "@aztec-kit/contracts-aztec/artifacts/SchnorrInitializerlessAccount";
import { setupLocalNetwork, type LocalNetwork } from "@aztec-kit/common/testing";
import {
  computeSigningKeyImmutablesHash,
  createSchnorrInitializerlessAccount,
  serializeSigningKey,
  createSigningKeyCapsule,
  type SigningPublicKey,
  deployWithImmutables,
  computeImmutablesAddress,
  createImmutablesInstance,
} from "../src/index.js";

const SIGNING_KEY_1: SigningPublicKey = {
  x: new Fr(111n),
  y: new Fr(222n),
};
const SIGNING_KEY_2: SigningPublicKey = {
  x: new Fr(333n),
  y: new Fr(444n),
};
const SALT_1 = new Fr(12345n);
const SALT_2 = new Fr(54321n);

describe("SchnorrInitializerlessAccount", () => {
  let network: LocalNetwork;
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    // Derive alice's address up-front so we can pre-fund it at genesis —
    // saves the bridge+claim round-trip before her deploy tx can pay gas.
    const testAccounts = await getInitialTestAccountsData();
    const [aliceAccount] = testAccounts;
    alice = aliceAccount.address;

    network = await setupLocalNetwork({ fundedAddresses: [alice] });
    node = network.node;

    wallet = await EmbeddedWallet.create(node, { ephemeral: true });
    // Deploy alice's schnorr account — the pre-funded genesis entry pays
    // for the class+instance publication.
    await deployFundedSchnorrAccounts(wallet, [aliceAccount]);
  }, 120_000);

  afterAll(async () => {
    await network?.stop();
  });

  // -- Pure computation tests (no deployment) --

  it("should produce different addresses for different signing keys", async () => {
    const result1 = await computeSchnorrAccountAddress(SIGNING_KEY_1, SALT_1);
    const result2 = await computeSchnorrAccountAddress(SIGNING_KEY_2, SALT_1);

    expect(result1.toString()).not.toBe(result2.toString());
  });

  it("should produce different addresses for different salts", async () => {
    const result1 = await computeSchnorrAccountAddress(SIGNING_KEY_1, SALT_1);
    const result2 = await computeSchnorrAccountAddress(SIGNING_KEY_1, SALT_2);

    expect(result1.toString()).not.toBe(result2.toString());
  });

  it("should compute immutables_hash from signing key alone (salt-independent)", async () => {
    const hash1 = await computeSigningKeyImmutablesHash(SIGNING_KEY_1);
    expect(hash1.toBigInt()).not.toBe(0n);

    // Same key → same hash (salt is not an input)
    const hash1Again = await computeSigningKeyImmutablesHash(SIGNING_KEY_1);
    expect(hash1.toBigInt()).toBe(hash1Again.toBigInt());

    // Different key → different hash
    const hash2 = await computeSigningKeyImmutablesHash(SIGNING_KEY_2);
    expect(hash1.toBigInt()).not.toBe(hash2.toBigInt());
  });

  // -- Deployment tests --

  it("should deploy account and read signing key back", async () => {
    const secretKey = Fr.random();
    const { signingPublicKey } = await createSchnorrInitializerlessAccount(secretKey);
    const serialized = await serializeSigningKey(signingPublicKey);

    const result = await deployWithImmutables(
      wallet,
      SchnorrInitializerlessAccountContractArtifact,
      serialized,
      { secretKey },
    );

    expect(result.instance.address).toBeDefined();

    // Read signing key back from capsule storage
    const contract = SchnorrInitializerlessAccountContract.at(result.instance.address, wallet);
    const { result: readResult } = await contract.methods.get_signing_public_key().simulate({
      from: alice,
      additionalScopes: [result.instance.address],
    });

    expect(readResult[0]).toEqual(signingPublicKey.x.toBigInt());
    expect(readResult[1]).toEqual(signingPublicKey.y.toBigInt());
  });

  it("should deploy with different secrets and get different addresses", async () => {
    const sk1 = Fr.random();
    const sk2 = Fr.random();

    const { signingPublicKey: pk1 } = await createSchnorrInitializerlessAccount(sk1);
    const { signingPublicKey: pk2 } = await createSchnorrInitializerlessAccount(sk2);

    const result1 = await deployWithImmutables(
      wallet,
      SchnorrInitializerlessAccountContractArtifact,
      await serializeSigningKey(pk1),
      { secretKey: sk1 },
    );
    const result2 = await deployWithImmutables(
      wallet,
      SchnorrInitializerlessAccountContractArtifact,
      await serializeSigningKey(pk2),
      { secretKey: sk2 },
    );

    expect(result1.instance.address.toString()).not.toBe(result2.instance.address.toString());
  });

  it("should fail with wrong capsule data", async () => {
    // Register the contract WITHOUT persisting the capsule to the store.
    // This way, only the transient capsule is available — and it has wrong data.
    const secretKey = Fr.random();
    const { signingPublicKey } = await createSchnorrInitializerlessAccount(secretKey);
    const serialized = await serializeSigningKey(signingPublicKey);

    const { instance } = await createImmutablesInstance(
      SchnorrInitializerlessAccountContractArtifact,
      serialized,
      { secretKey },
    );

    // Register contract in PXE but do NOT store the capsule
    await wallet.registerContract(
      instance,
      SchnorrInitializerlessAccountContractArtifact,
      secretKey,
    );

    const contract = SchnorrInitializerlessAccountContract.at(instance.address, wallet);

    // Wrong signing key — produces a different capsule that won't match the
    // committed `instance.immutables_hash`.
    const wrongKey: SigningPublicKey = {
      x: new Fr(signingPublicKey.x.toBigInt() + 1n),
      y: new Fr(signingPublicKey.y.toBigInt() + 1n),
    };
    const wrongCapsule = await createSigningKeyCapsule(instance.address, wrongKey);

    await expect(
      contract.methods
        .get_signing_public_key()
        .with({ capsules: [wrongCapsule] })
        .simulate({ from: alice, additionalScopes: [instance.address] }),
    ).rejects.toThrow("Immutables do not match instance immutables_hash");
  });
});

// -- Helper --

async function computeSchnorrAccountAddress(
  key: SigningPublicKey,
  salt: Fr,
): Promise<AztecAddress> {
  const { address } = await computeImmutablesAddress(
    SchnorrInitializerlessAccountContractArtifact,
    await serializeSigningKey(key),
    { salt },
  );
  return address;
}
