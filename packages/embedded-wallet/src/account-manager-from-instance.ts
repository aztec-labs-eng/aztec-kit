/**
 * Constructs an `AccountManager` from a pre-built `ContractInstanceWithAddress`,
 * bypassing `AccountManager.create()`.
 *
 * At v5.0.0-nightly.20260522 the upstream `AccountManager.create(wallet, secret,
 * contract, salt?)` signature doesn't accept an `immutablesHash` option, so it
 * always builds the contract instance with `immutablesHash = Fr.ZERO` — wrong
 * for our initializerless account whose signing key is committed via
 * `instance.immutables_hash`. We build the instance ourselves with
 * `getContractInstanceFromInstantiationParams({ immutablesHash })` and shove it
 * into AccountManager through its (TS-private, JS-public) positional constructor.
 *
 * `AccountManager.create` grew an `opts.immutablesHash` parameter from
 * 20260526+; once we move forward of that nightly, delete this file and use
 * the upstream API directly.
 */

import { AccountManager } from "@aztec/aztec.js/wallet";
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AccountContract } from "@aztec/aztec.js/account";
import type { Fr } from "@aztec/foundation/curves/bn254";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";

type AccountManagerCtor = new (
  wallet: Wallet,
  secretKey: Fr,
  accountContract: AccountContract,
  instance: ContractInstanceWithAddress,
  salt: Fr,
) => AccountManager;

export function createAccountManagerWithInstance(
  wallet: Wallet,
  secretKey: Fr,
  accountContract: AccountContract,
  instance: ContractInstanceWithAddress,
  salt: Fr,
): AccountManager {
  const Ctor = AccountManager as unknown as AccountManagerCtor;
  return new Ctor(wallet, secretKey, accountContract, instance, salt);
}
