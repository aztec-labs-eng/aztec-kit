/// # Immutables Macro
///
/// This macro auto-generates the verification and loading logic for the immutables pattern,
/// similar to how `#[storage]` works for state variables.
///
/// ## Usage
///
/// ```noir
/// #[immutables]
/// pub struct Immutables {
///     pub signing_key_x: Field,
///     pub signing_key_y: Field,
/// }
/// ```
///
/// ## What It Generates
///
/// - `Serialize` and `Deserialize` implementations (if not already implemented)
/// - `Immutables::init(context: &mut PrivateContext)` - Loads and verifies immutables against `instance.immutables_hash`
/// - `Immutables::init_unconstrained(context: UtilityContext)` - Unconstrained load without verification
///
/// ## Verification Method
///
/// The capsule stores the serialized immutable fields: `[field_0, field_1, ...]`. Verification:
/// 1. Load capsule data from storage
/// 2. Compute `expected = poseidon2_hash(capsule_data)`
/// 3. Verify `expected == instance.immutables_hash`
///
/// `immutables_hash` is a first-class field on `ContractInstance` (AZIP-9) that's folded into
/// `salted_initialization_hash` during address derivation, so the contract address commits to
/// the immutables without abusing `salt`.
///
/// ## Requirements
///
/// - The struct MUST be named `Immutables`

pub comptime fn immutables(s: TypeDefinition) -> Quoted {
    let struct_name = s.name();

    // Validate struct name
    if struct_name != quote { Immutables } {
        panic(
            f"The #[immutables] macro can only be applied to a struct named 'Immutables', got '{struct_name}' instead.",
        )
    }

    // Derive Serialize and Deserialize if not already implemented.
    let serialize_impl = aztec::macros::utils::derive_serialize_if_not_implemented(s);
    let (deserialize_impl, serialized_len) = derive_deserialize_if_not_implemented(s);

    // IMMUTABLES_SLOT: 0x1a0e563e6a2087002308173ed42dec43b9543a3684de63d6be9a958c0eaf5c45
    let IMMUTABLES_SLOT: Field =
        aztec::protocol::hash::poseidon2_hash_bytes("IMMUTABLES_SLOT".as_bytes());

    let layout_quoted = generate_immutables_layout(s, serialized_len);

    quote {
        $serialize_impl
        $deserialize_impl
        impl Immutables {
            pub fn init(context: &mut aztec::context::PrivateContext) -> Immutables {
                let address = context.this_address();

                // Safety: capsule_data is verified against immutables_hash committed in contract address
                let serialized_immutables: [Field; $serialized_len] = unsafe {
                    aztec::oracle::capsules::load(address, $IMMUTABLES_SLOT, address)
                        .unwrap_or_else(|| panic(f"Immutables not found in capsule for contract {address}"))
                };

                let expected = aztec::protocol::hash::poseidon2_hash(serialized_immutables);
                let instance = aztec::oracle::get_contract_instance::get_contract_instance(address);

                assert_eq(
                    expected,
                    instance.immutables_hash,
                    "Immutables do not match instance immutables_hash",
                );

                aztec::protocol::traits::Deserialize::deserialize(serialized_immutables)
            }

            pub unconstrained fn init_unconstrained(context: aztec::context::UtilityContext) -> Immutables {
                let address = context.this_address();

                let serialized_immutables: [Field; $serialized_len] = aztec::oracle::capsules::load(address, $IMMUTABLES_SLOT, address)
                    .unwrap_or_else(|| panic(f"Immutables not found in capsule for contract {address}"));

                aztec::protocol::traits::Deserialize::deserialize(serialized_immutables)
            }

            pub unconstrained fn store(context: aztec::context::UtilityContext, serialized_immutables: [Field; $serialized_len]) {
                let address = context.this_address();

                let expected = aztec::protocol::hash::poseidon2_hash(serialized_immutables);
                let instance = aztec::oracle::get_contract_instance::get_contract_instance(address);
                assert_eq(
                    expected,
                    instance.immutables_hash,
                    "Immutables data does not match instance immutables_hash, refusing to store",
                );

                aztec::oracle::capsules::store(address, $IMMUTABLES_SLOT, serialized_immutables, address);
            }
        }

        $layout_quoted
    }
}

comptime fn generate_immutables_layout(s: TypeDefinition, serialized_len: Quoted) -> Quoted {
    let module = s.module();
    let module_name = module.name();
    let immutables_layout_name = f"IMMUTABLES_LAYOUT_{module_name}".quoted_contents();
    let module_name_str = f"{module_name}".as_quoted_str();
    let module_name_len: u32 = std::meta::unquote!(quote { $module_name_str.as_bytes().len() });

    let concrete_serialized_len: u32 = std::meta::unquote!(quote { $serialized_len });

    let mut layout_struct_members = @[];
    let mut layout_constructors = @[];
    let mut field_index: u32 = 0;
    for field in s.fields_as_written() {
        let (name, _, _) = field;
        let index_as_field = field_index as Field;
        layout_struct_members =
            layout_struct_members.push_back(quote { pub $name: ImmutableLayoutEntry });
        layout_constructors = layout_constructors.push_back(
            quote { $name: ImmutableLayoutEntry { index: $index_as_field } },
        );
        field_index += 1;
    }
    let layout_struct_members = layout_struct_members.join(quote {,});
    let layout_constructors = layout_constructors.join(quote {,});

    quote {
        pub struct ImmutableLayoutEntry {
            pub index: Field,
        }

        pub struct ImmutablesLayoutFields {
            $layout_struct_members
        }

        pub struct ImmutablesLayout<let N: u32> {
            pub contract_name: str<N>,
            pub serialized_len: u32,
            pub fields: ImmutablesLayoutFields,
        }

        #[abi(immutables)]
        pub global $immutables_layout_name: ImmutablesLayout<$module_name_len> = ImmutablesLayout {
            contract_name: $module_name_str,
            serialized_len: $concrete_serialized_len,
            fields: ImmutablesLayoutFields { $layout_constructors }
        };
    }
}

comptime fn derive_deserialize_if_not_implemented(s: TypeDefinition) -> (Quoted, Quoted) {
    let typ = s.as_type();
    let (struct_def, generics) = typ.as_data_type().unwrap();
    let params = struct_def.fields(generics);

    let n_expr = if params.len() > 0 {
        params
            .map(|(_, param_type, _): (Quoted, Type, Quoted)| {
                quote { <$param_type as aztec::protocol::traits::Deserialize>::N }
            })
            .join(quote { + })
    } else {
        quote { 0 }
    };

    if s.as_type().implements(quote { aztec::protocol::traits::Deserialize }.as_trait_constraint()) {
        (quote {}, n_expr)
    } else {
        let mut offset_components: [Quoted] = @[];
        let mut field_deserialization = quote {};
        for i in 0..params.len() {
            let (name, param_type, _) = params[i];
            let field_n = quote { <$param_type as aztec::protocol::traits::Deserialize>::N };
            let offset_expr = if offset_components.len() == 0 {
                quote { 0 }
            } else {
                offset_components.map(|q: Quoted| q).join(quote { + })
            };
            offset_components = offset_components.push_back(field_n);
            let new_field = quote {
                let $name: $param_type = {
                    let mut field_arr: [Field; $field_n] = [0; $field_n];
                    for i in 0..$field_n {
                        field_arr[i] = fields[$offset_expr + i];
                    }
                    aztec::protocol::traits::Deserialize::deserialize(field_arr)
                };
            };
            field_deserialization = quote { $field_deserialization $new_field };
        }

        let member_names =
            params.map(|(name, _, _): (Quoted, Type, Quoted)| quote { $name }).join(quote { , });

        let stream_body = params
            .map(|(name, param_type, _): (Quoted, Type, Quoted)| {
                quote {
                    let $name = <$param_type as aztec::protocol::traits::Deserialize>::stream_deserialize(reader);
                }
            })
            .join(quote {});

        (
            quote {
            impl aztec::protocol::traits::Deserialize for $typ {
                let N: u32 = $n_expr;

                fn deserialize(fields: [Field; Self::N]) -> Self {
                    $field_deserialization
                    Self { $member_names }
                }

                fn stream_deserialize<let K: u32>(reader: &mut aztec::protocol::utils::reader::Reader<K>) -> Self {
                    $stream_body
                    Self { $member_names }
                }
            }
        },
            n_expr,
        )
    }
}
