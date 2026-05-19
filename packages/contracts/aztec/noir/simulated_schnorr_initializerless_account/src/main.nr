use aztec::macros::aztec;

// Stub account contract for SchnorrInitializerlessAccount, used during
// kernelless simulation. Matches the entrypoint + verify_private_authwit
// surface of the real account so PXE can resolve selectors against this
// class when the wallet overrides `currentContractClassId` for the
// instance. is_valid_impl returns true unconditionally -- auth witness
// generation is captured separately via the StubAuthWitnessProvider.
//
// No constructor: the real SchnorrInitializerlessAccount has no
// initializer (instances are constructed with initializationHash = 0).
#[aztec]
pub contract SimulatedSchnorrInitializerlessAccount {
    use aztec::{
        authwit::{account::AccountActions, auth::IS_VALID_SELECTOR, entrypoint::app::AppPayload},
        context::PrivateContext,
        macros::functions::{allow_phase_change, external, view},
    };

    #[external("private")]
    #[allow_phase_change]
    fn entrypoint(app_payload: AppPayload, fee_payment_method: u8, cancellable: bool) {
        let actions = AccountActions::init(self.context, is_valid_impl);
        actions.entrypoint(app_payload, fee_payment_method, cancellable);
    }

    #[external("private")]
    #[view]
    fn verify_private_authwit(_inner_hash: Field) -> Field {
        IS_VALID_SELECTOR
    }

    #[contract_library_method]
    fn is_valid_impl(_context: &mut PrivateContext, _outer_hash: Field) -> bool {
        true
    }
}
