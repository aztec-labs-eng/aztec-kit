/**
 * Extension of the upstream `AccountContractsProvider` that adds support for
 * our `schnorr-initializerless` account type. The upstream provider only
 * knows about `schnorr`, `ecdsasecp256k1`, and `ecdsasecp256r1`; this wrapper
 * delegates to it for everything except the stub-account lookups, which it
 * routes through the schnorr path (our entrypoint signature matches
 * schnorr's) and serves our own stub artifact for class-id registration.
 *
 * Upstream's `AccountContractsProvider` interface isn't re-exported via
 * `@aztec/wallets/embedded`. We recover it structurally through
 * `ConstructorParameters` on the base wallet class — that way, if upstream
 * adds a method, our `implements` clause fails to type-check and we know
 * to update.
 */

import type { Account, AccountContract } from "@aztec/aztec.js/account";
import type { Fq } from "@aztec/foundation/curves/bn254";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import type { CompleteAddress } from "@aztec/stdlib/contract";
import { EmbeddedWallet as EmbeddedWalletBase, type AccountType } from "@aztec/wallets/embedded";

import { SimulatedSchnorrInitializerlessAccountContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/SimulatedSchnorrInitializerlessAccount";
import { INITIALIZERLESS_TYPE } from "./initializerless-account-type";

/**
 * Upstream's `AccountContractsProvider` interface, recovered from the base
 * wallet's constructor signature (param 3). Tracking it this way means we
 * don't maintain a parallel mirror; structural changes upstream surface here
 * at type-check time.
 */
export type AccountContractsProvider = ConstructorParameters<typeof EmbeddedWalletBase>[3];

export class ExtendedAccountContractsProvider implements AccountContractsProvider {
  constructor(private readonly inner: AccountContractsProvider) {}

  getSchnorrAccountContract(signingKey: Fq): Promise<AccountContract> {
    return this.inner.getSchnorrAccountContract(signingKey);
  }

  getSchnorrInitializerlessAccountContract(signingKey: Fq): Promise<AccountContract> {
    return this.inner.getSchnorrInitializerlessAccountContract(signingKey);
  }

  getEcdsaRAccountContract(signingKey: Buffer): Promise<AccountContract> {
    return this.inner.getEcdsaRAccountContract(signingKey);
  }

  getEcdsaKAccountContract(signingKey: Buffer): Promise<AccountContract> {
    return this.inner.getEcdsaKAccountContract(signingKey);
  }

  getStubAccountContractArtifact(type: AccountType): Promise<ContractArtifact> {
    if (type === INITIALIZERLESS_TYPE) {
      return Promise.resolve(SimulatedSchnorrInitializerlessAccountContractArtifact);
    }
    return this.inner.getStubAccountContractArtifact(type);
  }

  createStubAccount(address: CompleteAddress, type: AccountType): Promise<Account> {
    if (type === INITIALIZERLESS_TYPE) {
      return this.inner.createStubAccount(address, "schnorr" as AccountType);
    }
    return this.inner.createStubAccount(address, type);
  }
}
