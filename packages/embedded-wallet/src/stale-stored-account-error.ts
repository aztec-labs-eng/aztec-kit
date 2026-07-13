import type { AztecAddress } from "@aztec/stdlib/aztec-address";

/**
 * Thrown by `EmbeddedWallet.loadStoredAccount` when a persisted account's
 * address — recomputed from its stored keys against the currently bundled
 * account contract — no longer matches the address it was stored under.
 *
 * This happens when the account was created by an earlier build whose
 * account-contract class differs (e.g. across an Aztec version upgrade): the
 * contract class id, and therefore the derived instance address, changed. The
 * walletDB is keyed by the old address, so it can't back the recomputed one and
 * every `send({ from })` would throw "… does not exist on this wallet."
 *
 * Consumers handle this by prompting the user to re-onboard — delete the stale
 * account (`deleteStoredAccount`) and create a fresh one.
 */
export class StaleStoredAccountError extends Error {
  readonly storedAddress: AztecAddress;
  readonly recomputedAddress: AztecAddress;

  constructor(storedAddress: AztecAddress, recomputedAddress: AztecAddress) {
    super(
      `Stored account ${storedAddress.toString()} was created by an incompatible ` +
        `wallet version and now derives ${recomputedAddress.toString()}. Re-onboard to continue.`,
    );
    this.name = "StaleStoredAccountError";
    this.storedAddress = storedAddress;
    this.recomputedAddress = recomputedAddress;
  }
}
