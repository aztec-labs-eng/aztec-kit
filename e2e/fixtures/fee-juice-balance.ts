import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { getPXEConfig } from "@aztec/pxe/server";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";

/**
 * Queries the public fee-juice balance of an address directly against the
 * Aztec node. Uses an ephemeral embedded wallet spun up just for this read.
 *
 * `balance_of_public` is a utility function; it doesn't send a tx, but
 * simulating it requires a `from` account that's registered with the PXE.
 * We use one of the initial test accounts that's always funded + registered
 * on local-network.
 */
export async function getPublicFeeJuiceBalance(nodeUrl: string, address: string): Promise<bigint> {
  const node = createAztecNodeClient(nodeUrl);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { ...getPXEConfig(), proverEnabled: false, concurrentContractSyncEnabled: true },
  });

  const [initial] = await getInitialTestAccountsData();
  const manager = await wallet.createSchnorrAccount(
    initial.secret,
    initial.salt,
    initial.signingKey,
  );

  const fj = FeeJuiceContract.at(wallet);
  const target = AztecAddress.fromStringUnsafe(address);
  const { result } = await fj.methods.balance_of_public(target).simulate({ from: manager.address });
  return BigInt(result.toString());
}
