mod public_key;

use aztec::{
    macros::{aztec, AztecConfig},
    messages::{
        discovery::{ComputeNoteHash, ComputeNoteNullifier, CustomMessageHandler},
        processing::offchain::OffchainInboxSync,
    },
    protocol::address::AztecAddress,
};

/// Empty override to opt-out of state syncing. This contract does not hold private state,
/// so runnning the sync process just results in unnecessary RPC calls
unconstrained fn no_sync(
    _contract_address: AztecAddress,
    _compute_note_hash: ComputeNoteHash,
    _compute_note_nullifier: ComputeNoteNullifier,
    _process_custom_message: Option<CustomMessageHandler>,
    _offchain_inbox_sync: Option<OffchainInboxSync>,
    _scope: AztecAddress,
) {}

#[aztec(AztecConfig::new().custom_sync_state(crate::no_sync))]
pub contract SchnorrInitializerlessAccount {
    use aztec::{
        authwit::{
            account::AccountActions,
            auth::{compute_authwit_message_hash, compute_authwit_nullifier},
            entrypoint::app::AppPayload,
        },
        context::PrivateContext,
        hash::compute_siloed_nullifier,
        macros::functions::{allow_phase_change, external, view},
        oracle::{
            auth_witness::get_auth_witness,
            get_nullifier_membership_witness::get_low_nullifier_membership_witness,
            notes::set_sender_for_tags,
        },
        protocol::address::AztecAddress,
    };

    use crate::public_key::PublicKey;

    use immutables::immutables;

    #[immutables]
    pub struct Immutables {
        pub public_key: PublicKey,
    }

    #[external("utility")]
    unconstrained fn store_immutables(serialized_immutables: [Field; 2]) {
        Immutables::store(self.context, serialized_immutables);
    }

    #[external("private")]
    #[allow_phase_change]
    fn entrypoint(app_payload: AppPayload, fee_payment_method: u8, cancellable: bool) {
        // Safety: set_sender_for_tags is an oracle call that registers this account
        // as the sender for private note delivery in nested calls.
        unsafe { set_sender_for_tags(self.address) };

        let actions = AccountActions::init(self.context, is_valid_impl);
        actions.entrypoint(app_payload, fee_payment_method, cancellable);
    }

    #[external("private")]
    #[view]
    fn verify_private_authwit(inner_hash: Field) -> Field {
        let actions = AccountActions::init(self.context, is_valid_impl);
        actions.verify_private_authwit(inner_hash)
    }

    #[contract_library_method]
    fn is_valid_impl(context: &mut PrivateContext, outer_hash: Field) -> bool {
        let immutables = Immutables::init(context);
        let public_key = immutables.public_key;

        // Safety: The witness is only used as a "magical value" that makes the
        // signature verification below pass.
        //
        // v5 schnorr verification uses field-element signing with the signature
        // packed as 4 limbs (s_hi, s_lo, e_hi, e_lo) and the message passed as
        // a Field, not as 32 BE bytes -- matches upstream `SchnorrAccount`. The
        // TS-side `createAuthWit` must serialize via `signature.toLimbFields()`
        // for this to verify.
        let limbs: [Field; 4] = unsafe { get_auth_witness(outer_hash) };
        let signature = (
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[0], limbs[1]),
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[2], limbs[3]),
        );

        let pub_key =
            std::embedded_curve_ops::EmbeddedCurvePoint { x: public_key.x, y: public_key.y };

        schnorr::verify_signature(pub_key, signature, outer_hash)
    }

    #[external("utility")]
    unconstrained fn lookup_validity(consumer: AztecAddress, inner_hash: Field) -> bool {
        let immutables = Immutables::init_unconstrained(self.context);
        let public_key = immutables.public_key;

        let message_hash = compute_authwit_message_hash(
            consumer,
            self.context.chain_id(),
            self.context.version(),
            inner_hash,
        );

        let limbs: [Field; 4] = get_auth_witness(message_hash);
        let signature = (
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[0], limbs[1]),
            std::embedded_curve_ops::EmbeddedCurveScalar::new(limbs[2], limbs[3]),
        );

        let pub_key =
            std::embedded_curve_ops::EmbeddedCurvePoint { x: public_key.x, y: public_key.y };

        let valid_in_private = schnorr::verify_signature(pub_key, signature, message_hash);
        let nullifier = compute_authwit_nullifier(self.address, inner_hash);
        let siloed_nullifier = compute_siloed_nullifier(consumer, nullifier);
        let (low_leaf_preimage, _witness) =
            get_low_nullifier_membership_witness(self.context.block_header(), siloed_nullifier);
        let is_spent = low_leaf_preimage.nullifier == siloed_nullifier;

        !is_spent & valid_in_private
    }

    /// Returns the signing public key (for testing).
    #[external("private")]
    fn get_signing_public_key() -> pub (Field, Field) {
        let immutables = Immutables::init(self.context);
        let public_key = immutables.public_key;
        (public_key.x, public_key.y)
    }
}
