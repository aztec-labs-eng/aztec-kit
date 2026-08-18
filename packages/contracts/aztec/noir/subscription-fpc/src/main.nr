use aztec::macros::aztec;

#[aztec]
contract SubscriptionFPC {

    use aztec::{
        authwit::{auth::{compute_inner_authwit_hash, IS_VALID_SELECTOR}, entrypoint::FunctionCall},
        macros::{
            functions::{allow_phase_change, external, initializer, internal},
            notes::note,
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        note::{
            note_getter_options::NoteGetterOptions, note_interface::NoteProperties,
            note_viewer_options::NoteViewerOptions,
        },
        protocol::{
            abis::{function_selector::FunctionSelector, gas_settings::GasSettings},
            address::AztecAddress,
            hash::{poseidon2_hash, poseidon2_hash_with_separator},
            traits::{Deserialize, Packable, Serialize, ToField},
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable},
        utils::comparison::Comparator,
    };

    /// Domain separator for the per-seat "ticket" nullifiers emitted on
    /// subscription. Picked to be clearly app-specific (ASCII "SEAT") and
    /// verified not to collide with any aztec-nr `DOM_SEP__*` protocol
    /// constant. Nullifiers are siloed by contract address before they hit
    /// the tree, so this only needs to stay distinct from other separators
    /// used *within this contract* (notably PublicImmutable's own
    /// initialization-nullifier separator).
    global SEAT_NULLIFIER_SEPARATOR: u32 = 1397047636;

    /// Asserts that the transaction's max possible fee is within the FPC's allowance (`max_fee`).
    ///
    /// Doing this in private rather than later (like in public teardown) ensures that a sponsored
    /// transaction's private execution cannot be proven if it would be possible for it to
    /// exceed the allowance (`max_fee`).
    ///
    /// If, instead, the assertion was done in public teardown, a transaction that exceeds the
    /// FPC's `max_fee` would revert during teardown, but could still have its private portion
    /// proven, and therefore could still be executed by a sequencer and included in a block.
    /// In that case, the FPC would be responsible for paying some fee larger than `max_fee`.
    #[contract_library_method]
    fn assert_fee_within_max(gas_settings: GasSettings, max_fee: u128) {
        let total_gas = gas_settings.gas_limits + gas_settings.teardown_gas_limits;
        let max_possible_fee: u128 = (total_gas.da_gas as u128)
            * gas_settings.max_fees_per_gas.fee_per_da_gas
            + (total_gas.l2_gas as u128) * gas_settings.max_fees_per_gas.fee_per_l2_gas;
        assert(max_possible_fee <= max_fee, "Gas settings exceed subscription max_fee");
    }

    /// Computes the inner (unsiloed) seat-ticket nullifier for a
    /// `(config_id, seat)` pair. The protocol silos this by the FPC's
    /// contract address before inserting it into the nullifier tree, so no
    /// other contract can ever emit a colliding value. Grabbing a seat is
    /// therefore just emitting this nullifier: the protocol's own
    /// duplicate-nullifier rejection enforces at most one claim per seat, and
    /// with `seat < max_users` at most `max_users` distinct seats can ever
    /// exist for a config — the entire capacity mechanism, with no shared
    /// mutable state on the signup path.
    #[contract_library_method]
    fn compute_seat_nullifier_inner(config_id: Field, seat: u32) -> Field {
        poseidon2_hash_with_separator([config_id, seat as Field], SEAT_NULLIFIER_SEPARATOR)
    }

    #[derive(Packable, Eq)]
    #[note]
    pub struct SubscriptionNote {
        uses: u32,
        max_fee: u128,
        config_id: Field,
    }

    /// Public, immutable per-config sponsorship parameters. Written once by
    /// `sign_up` (public) and read privately during `subscribe`. Keyed by
    /// `config_id = poseidon2([app, selector, current_index])` in the
    /// `configs` map, one `PublicImmutable` per config.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        max_fee: u128,
        max_uses: u32,
        max_users: u32,
    }

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress, Context>,
        subscriptions: Owned<PrivateSet<SubscriptionNote, Context>, Context>,
        configs: Map<Field, PublicImmutable<Config, Context>, Context>,
    }

    #[initializer]
    #[external("public")]
    fn constructor(admin: AztecAddress) {
        self.storage.admin.initialize(admin);
    }

    /// Registers a sponsored `(app, selector, current_index)` config. Public
    /// so it can write `PublicImmutable` config state (private functions
    /// cannot initialize public storage). Admin-gated: the admin is a
    /// `PublicImmutable<AztecAddress>` readable in public.
    ///
    /// `PublicImmutable::initialize` emits a per-config initialization
    /// nullifier, so re-running `sign_up` at a `config_id` that already
    /// exists reverts on the duplicate nullifier — this replaces the manual
    /// uniqueness nullifier the old slot-note design pushed by hand, and
    /// guarantees exactly one config per `config_id`.
    #[external("public")]
    fn sign_up(
        app: AztecAddress,
        selector: FunctionSelector,
        current_index: u32,
        max_uses: u32,
        max_fee: u128,
        max_users: u32,
    ) {
        assert(
            self.msg_sender() == self.storage.admin.read(),
            "Only the admin can add sponsored apps",
        );
        assert(max_users > 0, "max_users must be greater than zero");
        assert(max_uses > 0, "max_uses must be greater than zero");

        let config_id = poseidon2_hash([
            app.to_field(),
            selector.to_field(),
            current_index.to_field(),
        ]);

        self.storage.configs.at(config_id).initialize(Config { max_fee, max_uses, max_users });
    }

    #[external("private")]
    #[allow_phase_change]
    fn sponsor(call: FunctionCall, current_index: u32, user: AztecAddress) {
        // Assert we're at the top of the stack
        assert(
            self.context.maybe_msg_sender() == Option::none(),
            "msg_sender must be none for sponsored calls",
        );

        let config_id = poseidon2_hash([
            call.target_address.to_field(),
            call.function_selector.to_field(),
            current_index.to_field(),
        ]);

        // Assert the user still has an active subscription
        let options = NoteGetterOptions::new().set_limit(1).select(
            SubscriptionNote::properties().config_id,
            Comparator.EQ,
            config_id,
        );
        let subscription = self.storage.subscriptions.at(user).pop_notes(options);
        assert(subscription.len() > 0, "No active subscription found for this user and function");
        let subscription = subscription.get(0);
        if subscription.uses > 0 {
            self
                .storage
                .subscriptions
                .at(user)
                .insert(
                    SubscriptionNote {
                        uses: subscription.uses - 1,
                        max_fee: subscription.max_fee,
                        config_id,
                    },
                )
                .deliver(MessageDelivery::onchain_unconstrained().with_sender(user))
        }

        assert_fee_within_max(self.context.gas_settings(), subscription.max_fee);

        // We are convinced, sponsor the fee and end setup
        self.context.set_as_fee_payer();
        self.context.end_setup();

        self.internal._call_sponsored_fn(call);
    }

    #[internal("private")]
    fn _call_sponsored_fn(call: FunctionCall) {
        if call.is_public {
            self.context.call_public_function_with_calldata_hash(
                call.target_address,
                call.args_hash,
                call.is_static,
                call.hide_msg_sender,
            );
        } else {
            assert(
                !call.hide_msg_sender,
                "Incompatible flag. `hide_msg_sender = true` is only available for public calls.",
            );
            let _result = self.context.call_private_function_with_args_hash(
                call.target_address,
                call.function_selector,
                call.args_hash,
                call.is_static,
            );
        }
    }

    /// Admin-gated entrypoint used solely by `calibrateSponsoredApp` to estimate
    /// gas for a sponsored function under the FPC's dispatch path, without
    /// touching state or paying fees. Mirrors `subscribe`'s call dispatch
    /// (`_call_sponsored_fn`) so a simulation measures the same execution
    /// cost minus the slot/subscription bookkeeping.
    ///
    /// Top-of-stack like `subscribe`/`sponsor` (msg_sender must be none) so
    /// the gas profile matches the runtime call path. The admin gate is what
    /// makes this safe to expose: a sponsored call dispatched here runs with
    /// `msg_sender == FPC_ADDRESS`, so without the gate any user could
    /// impersonate the FPC. Auth uses an inner-hash authwit because the
    /// standard `assert_current_call_valid_authwit` expects a present
    /// `msg_sender`, which we don't have at top-of-stack. Admin signs off on
    /// the (selector, args_hash) inner hash for this specific calibration
    /// call, with `fpc.address` as the consumer.
    #[external("private")]
    #[allow_phase_change]
    fn calibrate(call: FunctionCall, user: AztecAddress) {
        // Assert we're at the top of the stack
        assert(
            self.context.maybe_msg_sender() == Option::none(),
            "msg_sender must be none for calibrate",
        );

        let inner_hash = compute_inner_authwit_hash([
            self.context.selector().to_field(),
            self.context.get_args_hash(),
        ]);
        // Inlined `assert_inner_hash_valid_authwit` minus the nullifier push.
        // The standard helper emits a replay-protection nullifier on the
        // authwit, but `calibrate` is simulation-only (never sent on chain)
        // so replay isn't a concern, and the nullifier emission is the
        // entire measured calibrate overhead. Skipping it makes the calibrate path
        // gas-equivalent to the runtime sponsor/subscribe path minus their
        // bookkeeping, so the helper that wraps this entrypoint can return
        // the sponsored fn's standalone gas without subtracting an overhead
        // constant.
        let result: Field = self
            .context
            .static_call_private_function(
                self.storage.admin.read(),
                comptime { FunctionSelector::from_signature("verify_private_authwit(Field)") },
                [inner_hash],
            )
            .get_preimage();
        assert(result == IS_VALID_SELECTOR, "Message not authorized by account");

        self.context.end_setup();
        self.internal._call_sponsored_fn(call);
    }

    #[external("private")]
    #[allow_phase_change]
    fn subscribe(call: FunctionCall, current_index: u32, user: AztecAddress, seat: u32) {
        // Assert we're at the top of the stack
        assert(
            self.context.maybe_msg_sender() == Option::none(),
            "msg_sender must be none for sponsored calls",
        );

        let config_id = poseidon2_hash([
            call.target_address.to_field(),
            call.function_selector.to_field(),
            current_index.to_field(),
        ]);

        // Private read of the config's public state. This proves the config
        // was initialized (via `sign_up`) against the tx's anchor block, and
        // yields its value with zero side effects — no shared mutable state,
        // so concurrent subscribers never contend here. It also replaces the
        // old "operator must call sign_up first" check: reading an
        // uninitialized `PublicImmutable` reverts.
        let config = self.storage.configs.at(config_id).read();

        assert(seat < config.max_users, "Seat out of range");

        // Claim the seat by emitting its ticket nullifier. Emitted here
        // (before `end_setup`) so it's non-revertible, matching the old
        // slot-pop nullifier's placement/semantics. Two subscribers racing
        // for the same seat produce the same nullifier, so at most one lands;
        // distinct seats never collide.
        self.context.push_nullifier_unsafe(compute_seat_nullifier_inner(config_id, seat));

        assert_fee_within_max(self.context.gas_settings(), config.max_fee);

        // We are convinced, sponsor the fee and end setup
        self.context.set_as_fee_payer();
        self.context.end_setup();

        self
            .storage
            .subscriptions
            .at(user)
            .insert(SubscriptionNote { uses: config.max_uses - 1, max_fee: config.max_fee, config_id })
            .deliver(MessageDelivery::onchain_unconstrained().with_sender(user));

        // We allow calling the sponsored function in the same tx as the subscription
        self.internal._call_sponsored_fn(call);
    }

    /// Reads a config's sponsorship parameters. Used by clients/tests to
    /// discover `max_users` (for seat picking) and other config values.
    /// Reverts if the config was never signed up.
    #[external("utility")]
    unconstrained fn get_config(config_id: Field) -> pub Config {
        self.storage.configs.at(config_id).read()
    }

    /// Returns the INNER (unsiloed) seat-ticket nullifier for a
    /// `(config_id, seat)` pair, via the same library method `subscribe`
    /// uses. Lets clients/tests pin TS↔Noir hash parity before siloing.
    #[external("utility")]
    unconstrained fn compute_seat_nullifier(config_id: Field, seat: u32) -> Field {
        compute_seat_nullifier_inner(config_id, seat)
    }

    #[external("utility")]
    unconstrained fn get_subscription_info(user: AztecAddress, config_id: Field) -> (bool, u32) {
        let options = NoteViewerOptions::new()
            .select(SubscriptionNote::properties().config_id, Comparator.EQ, config_id)
            .set_limit(1);
        let notes = self.storage.subscriptions.at(user).view_notes(options);
        if notes.len() > 0 {
            (true, notes.get_unchecked(0).uses)
        } else {
            (false, 0)
        }
    }

}
