/**
 * Generic Initializerless Immutables Utilities
 *
 * Contract-agnostic utilities for the initializerless immutables pattern.
 * Any contract using the `#[immutables]` Noir macro can use these functions.
 *
 * Pattern (post AZIP-9):
 * 1. `immutablesHash = poseidon2_hash(serialized_immutables)` is committed via
 *    `ContractInstance.immutablesHash`, which folds into address derivation.
 * 2. Capsule stored at IMMUTABLES_SLOT contains the serialized immutables directly
 *    (no salt prefix).
 * 3. Runtime verification: Noir hashes capsule data and verifies against
 *    `instance.immutables_hash`.
 */

import { Fr } from "@aztec/aztec.js/fields";
import { Capsule } from "@aztec/stdlib/tx";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { PublicKeys } from "@aztec/stdlib/keys";
import {
  computeContractAddressFromInstance,
  getContractClassFromArtifact,
} from "@aztec/stdlib/contract";
import type {
  ContractArtifact,
  StructValue,
  IntegerValue,
  TypedStructFieldValue,
  BasicValue,
} from "@aztec/stdlib/abi";
import type { ContractInstance, ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { ContractFunctionInteraction } from "@aztec/aztec.js/contracts";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

/**
 * IMMUTABLES_SLOT — must match the Noir macro's computed slot.
 * poseidon2_hash_bytes("IMMUTABLES_SLOT".as_bytes())
 */
export const IMMUTABLES_SLOT = new Fr(
  0x1a0e563e6a2087002308173ed42dec43b9543a3684de63d6be9a958c0eaf5c45n,
);

// ---------------------------------------------------------------------------
// Artifact introspection
// ---------------------------------------------------------------------------

export interface ImmutableFieldLayout {
  index: number;
}

export interface ImmutablesLayout {
  serializedLen: number;
  fields: Record<string, ImmutableFieldLayout>;
}

export function getImmutablesLayout(artifact: ContractArtifact): ImmutablesLayout | null {
  const immutablesExports = artifact.outputs.globals.immutables
    ? (artifact.outputs.globals.immutables as StructValue[])
    : [];

  const layoutForContract = immutablesExports.find((entry) => {
    const contractNameField = entry.fields.find((field) => field.name === "contract_name")
      ?.value as BasicValue<"string", string> | undefined;
    return contractNameField?.value === artifact.name;
  });

  if (!layoutForContract) {
    return null;
  }

  const serializedLenValue = layoutForContract.fields.find(
    (field) => field.name === "serialized_len",
  )?.value as IntegerValue | undefined;
  const serializedLen = serializedLenValue ? parseInt(serializedLenValue.value, 16) : 0;

  const fieldsStruct = layoutForContract.fields.find((field) => field.name === "fields") as
    | TypedStructFieldValue<StructValue>
    | undefined;

  if (!fieldsStruct) {
    return { serializedLen, fields: {} };
  }

  const layoutFields = fieldsStruct.value.fields as TypedStructFieldValue<StructValue>[];

  const fields = layoutFields.reduce((acc: Record<string, ImmutableFieldLayout>, field) => {
    const indexValue = field.value.fields.find((f) => f.name === "index")?.value as IntegerValue;
    acc[field.name] = {
      index: parseInt(indexValue.value, 16),
    };
    return acc;
  }, {});

  return { serializedLen, fields };
}

export function serializeFromLayout(
  artifact: ContractArtifact,
  values: Record<string, Fr | Fr[]>,
): Fr[] {
  const layout = getImmutablesLayout(artifact);
  if (!layout) {
    throw new Error(`Contract artifact "${artifact.name}" has no #[abi(immutables)] layout`);
  }

  const layoutFieldNames = Object.keys(layout.fields);

  for (const name of layoutFieldNames) {
    if (!(name in values)) {
      throw new Error(
        `Missing immutable field "${name}". Expected: ${layoutFieldNames.join(", ")}`,
      );
    }
  }

  for (const name of Object.keys(values)) {
    if (!(name in layout.fields)) {
      throw new Error(
        `Unknown immutable field "${name}". Expected: ${layoutFieldNames.join(", ")}`,
      );
    }
  }

  const sortedEntries = layoutFieldNames
    .map((name) => ({ name, index: layout.fields[name].index }))
    .sort((a, b) => a.index - b.index);

  const result: Fr[] = [];
  for (const entry of sortedEntries) {
    const value = values[entry.name];
    if (Array.isArray(value)) {
      result.push(...value);
    } else {
      result.push(value);
    }
  }

  if (result.length !== layout.serializedLen) {
    throw new Error(
      `Serialized length mismatch: got ${result.length} Fr elements, expected ${layout.serializedLen}`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Low-level building blocks
// ---------------------------------------------------------------------------

export async function computeImmutablesHash(serializedImmutables: Fr[]): Promise<Fr> {
  const result = await poseidon2Hash(serializedImmutables);
  return new Fr(result.toBigInt());
}

export function createImmutablesCapsule(
  contractAddress: AztecAddress,
  serializedImmutables: Fr[],
): Capsule {
  return new Capsule(contractAddress, IMMUTABLES_SLOT, serializedImmutables, contractAddress);
}

// ---------------------------------------------------------------------------
// Instance creation
// ---------------------------------------------------------------------------

export interface ImmutablesInstanceOptions {
  salt?: Fr;
  publicKeys?: PublicKeys;
  deployer?: AztecAddress;
  secretKey?: Fr;
}

export interface CreateImmutablesInstanceResult {
  instance: ContractInstanceWithAddress;
  salt: Fr;
  immutablesHash: Fr;
}

export async function createImmutablesInstance(
  artifact: ContractArtifact,
  serializedImmutables: Fr[],
  options?: ImmutablesInstanceOptions,
): Promise<CreateImmutablesInstanceResult> {
  const salt = options?.salt ?? Fr.random();
  const immutablesHash = await computeImmutablesHash(serializedImmutables);

  // No initializer path: initializationHash = Fr.ZERO
  const contractClass = await getContractClassFromArtifact(artifact);
  const rawInstance: ContractInstance = {
    version: 2,
    salt,
    deployer: options?.deployer ?? AztecAddress.ZERO,
    currentContractClassId: contractClass.id,
    originalContractClassId: contractClass.id,
    initializationHash: Fr.ZERO,
    immutablesHash,
    publicKeys: options?.publicKeys ?? PublicKeys.default(),
  };
  const address = await computeContractAddressFromInstance(rawInstance);
  const instance: ContractInstanceWithAddress = { ...rawInstance, address };

  return { instance, salt, immutablesHash };
}

/**
 * Pre-computes the contract address for given immutables without deploying.
 */
export async function computeImmutablesAddress(
  artifact: ContractArtifact,
  serializedImmutables: Fr[],
  options?: ImmutablesInstanceOptions,
): Promise<{ address: AztecAddress; capsuleData: Fr[] }> {
  const { instance } = await createImmutablesInstance(artifact, serializedImmutables, options);
  return {
    address: instance.address,
    capsuleData: serializedImmutables,
  };
}

// ---------------------------------------------------------------------------
// Full deployment (register + store immutables)
// ---------------------------------------------------------------------------

export interface DeployWithImmutablesResult {
  instance: ContractInstanceWithAddress;
  capsuleData: Fr[];
}

export interface DeployWithImmutablesOptions extends ImmutablesInstanceOptions {
  publishClass?: boolean;
  publishInstance?: boolean;
}

export async function deployWithImmutables(
  wallet: Wallet,
  artifact: ContractArtifact,
  serializedImmutables: Fr[],
  options?: DeployWithImmutablesOptions,
): Promise<DeployWithImmutablesResult> {
  const { instance } = await createImmutablesInstance(artifact, serializedImmutables, options);

  // Register the contract with the wallet (PXE)
  await wallet.registerContract(instance, artifact, options?.secretKey);

  // Validate serialized immutables against the layout
  const layout = getImmutablesLayout(artifact);
  if (layout && serializedImmutables.length !== layout.serializedLen) {
    const fieldNames = Object.keys(layout.fields).join(", ");
    throw new Error(
      `Immutables serialized length mismatch: expected ${layout.serializedLen} Fr elements for fields (${fieldNames}), got ${serializedImmutables.length}`,
    );
  }

  // Persist immutables to PXE's CapsuleStore via store_immutables utility function
  const storeImmutablesAbi = artifact.functions.find((f) => f.name === "store_immutables");
  if (!storeImmutablesAbi) {
    throw new Error(`store_immutables function not found in artifact ${artifact.name}`);
  }
  const accounts = await wallet.getAccounts();
  const deployerAddress = accounts[0]?.item ?? AztecAddress.ZERO;
  const storeCall = new ContractFunctionInteraction(wallet, instance.address, storeImmutablesAbi, [
    serializedImmutables,
  ]);
  await storeCall.simulate({
    from: deployerAddress,
    additionalScopes: [instance.address],
  });

  return { instance, capsuleData: serializedImmutables };
}
