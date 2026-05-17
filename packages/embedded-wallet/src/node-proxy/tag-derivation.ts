import type { Fq } from "@aztec/foundation/curves/bn254";
import type { AztecAddress } from "@aztec/stdlib/aztec-address";
import type { CompleteAddress } from "@aztec/stdlib/contract";
import { ExtendedDirectionalAppTaggingSecret, SiloedTag } from "@aztec/stdlib/logs";

/**
 * Key material for an account whose incoming notes the wallet wants to
 * scan for. `ivsk` is the master incoming viewing secret key derived from
 * the account's secret; `completeAddress` is the address bundle (pkHash +
 * partialAddress) needed for the DH derivation.
 */
export type RecipientKeyMaterial = {
  address: AztecAddress;
  completeAddress: CompleteAddress;
  ivsk: Fq;
};

/**
 * Compute the SiloedTag values PXE will scan for one
 * `(sender, recipient, app)` directional triple over indices
 * `[fromIndex, fromIndex + count)`.
 *
 * Mirrors PXE's `syncTaggedPrivateLogs` derivation:
 *   secret = ExtendedDirectionalAppTaggingSecret.compute(
 *     recipient.completeAddress,
 *     recipient.ivsk,
 *     sender,                     // counterparty (or self, for self-notes)
 *     app,                        // contract address calling getPendingTaggedLogsV2
 *     recipient.address,          // direction marker — always the recipient
 *   )
 *   tag_i = SiloedTag.compute({ extendedSecret: secret, index: i })
 *
 * The wallet computes the EXACT same values PXE would compute. The DH
 * derivation is symmetric (`(h_self + ivsk_self) * Addr_Point_other == ...`)
 * so as long as we hold the recipient's ivsk we can re-derive every tag
 * for any sender/app combination — no need for the sender's key material.
 *
 * Returns `undefined` when the secret cannot be computed (e.g.
 * `sender` isn't a valid address point); callers skip that combination.
 */
export async function computeSiloedTagsForWindow(
  recipient: RecipientKeyMaterial,
  sender: AztecAddress,
  app: AztecAddress,
  fromIndex: number,
  count: number,
): Promise<SiloedTag[] | undefined> {
  const extendedSecret = await ExtendedDirectionalAppTaggingSecret.compute(
    recipient.completeAddress,
    recipient.ivsk,
    sender,
    app,
    recipient.address,
  );
  if (!extendedSecret) return undefined;

  const tags = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      SiloedTag.compute({ extendedSecret, index: fromIndex + i }),
    ),
  );
  return tags;
}
