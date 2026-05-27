mod test;

use aztec::macros::aztec;

#[aztec]
pub contract ProofOfPassword {

    use aztec::{
        macros::{functions::{external, initializer, only_self}, storage::storage},
        protocol::{address::AztecAddress, hash::poseidon2_hash, traits::{Serialize, ToField}},
        state_vars::PublicImmutable,
    };
    use compressed_string::FieldCompressedString;
    use token::Token;

    #[storage]
    struct Storage<Context> {
        go_coin_address: PublicImmutable<AztecAddress, Context>,
        password_hash: PublicImmutable<Field, Context>,
    }

    #[initializer]
    #[external("private")]
    fn constructor(go_coin_address: AztecAddress, password: str<31>) {
        let field_compressed_str = FieldCompressedString::from_string(password);
        let password_hash = poseidon2_hash(field_compressed_str.serialize());
        self.enqueue(ProofOfPassword::at(self.address)._init_storage(go_coin_address, password_hash));
    }

    #[external("public")]
    #[only_self]
    fn _init_storage(go_coin_address: AztecAddress, password_hash: Field) {
        self.storage.go_coin_address.initialize(go_coin_address);
        self.storage.password_hash.initialize(password_hash);
    }

    #[external("private")]
    fn check_password_and_mint(password: str<31>, to: AztecAddress) {
        let field_compressed_str = FieldCompressedString::from_string(password);
        let password_hash = self.storage.password_hash.read();
        assert(
            poseidon2_hash(field_compressed_str.serialize()) == password_hash,
            f"Invalid password {password}",
        );

        let address = self.storage.go_coin_address.read();
        self.call(Token::at(address).mint_to_private(to, 1000));

        // Derive nullifier from sender and password. This is a privacy leak, since
        // knowing the password and an address is sufficient to know if someone has used this
        // contract or not. But at least, they need the password
        let nullifier = poseidon2_hash([to.to_field(), field_compressed_str.serialize()[0]]);
        self.context.push_nullifier_unsafe(nullifier);
    }
}
