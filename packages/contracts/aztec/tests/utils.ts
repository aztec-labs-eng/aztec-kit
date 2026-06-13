import type { AztecNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet, type EmbeddedWalletOptions } from "@aztec/wallets/embedded";
import type {
  ContractInstanceWithAddress,
  InteractionWaitOptions,
  SendReturn,
} from "@aztec/aztec.js/contracts";
import type { SendOptions } from "@aztec/aztec.js/wallet";
import type { ExecutionPayload } from "@aztec/stdlib/tx";
import { BaseWallet } from "@aztec/wallet-sdk/base-wallet";
import { getInitialTestAccountsData } from "@aztec/accounts/testing";
import { createFundedInitializerlessAccounts } from "@aztec/wallets/testing";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { deriveKeys } from "@aztec/aztec.js/keys";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { publishContractClass, publishInstance } from "@aztec/aztec.js/deployment";
import {
  AuthRegistryArtifact,
  getStandardAuthRegistry,
} from "@aztec/standard-contracts/auth-registry";
import { SubscriptionFPC } from "../lib/subscription-fpc.js";
import { SubscriptionFPCContractArtifact } from "../noir/artifacts/SubscriptionFPC.js";
import { setupLocalNetwork, TEST_FEE_PADDING } from "@aztec-kit/common/testing";

/**
 * Fixed secret used for the SubscriptionFPC across all tests. Combined with
 * a random salt per-suite, this lets the fixture pre-compute the FPC's
 * address and include it in the genesis pre-funded set — so the deploy tx
 * and every sponsored call can pay for themselves without bridging.
 *
 * The salt randomises per `setupTestContext()` call so parallel suites
 * can't collide on the same deterministic address.
 */
const FPC_SECRET_KEY = Fr.fromString(
  "0x00000000000000000000000000000000000000000000000000000000deadbeef",
);

export interface TestContext {
  node: AztecNode;
  wallet: EmbeddedWallet;
  admin: AztecAddress;
  feeJuice: FeeJuiceContract;
  /** Tears down the in-process anvil + node. */
  stop: () => Promise<void>;
}

async function deriveAdminAddress(): Promise<AztecAddress> {
  const [account] = await getInitialTestAccountsData();
  return account.address;
}

async function computeFpcAddress(admin: AztecAddress, salt: Fr): Promise<AztecAddress> {
  const { publicKeys } = await deriveKeys(FPC_SECRET_KEY);
  // `deployer` must match what the real deploy below passes — the contract
  // address derivation hashes it, so omitting it here pre-funds a different
  // address than the FPC that actually gets deployed.
  const instance = await getContractInstanceFromInstantiationParams(
    SubscriptionFPCContractArtifact,
    {
      constructorArgs: [admin],
      salt,
      publicKeys,
      deployer: admin,
    },
  );
  return instance.address;
}

/**
 * EmbeddedWallet subclass that skips pre-simulation before sending.
 * EmbeddedWallet.sendTx simulates first to estimate gas, which causes
 * expected-to-revert txs to fail before they ever reach the node.
 * This wallet calls BaseWallet.sendTx directly, bypassing that simulation.
 */
export class GrieferWallet extends EmbeddedWallet {
  static override create<T extends EmbeddedWallet = GrieferWallet>(
    nodeOrUrl: string | AztecNode,
    options?: EmbeddedWalletOptions,
  ): Promise<T> {
    return super.create<T>(nodeOrUrl, options);
  }

  public override sendTx<W extends InteractionWaitOptions = undefined>(
    executionPayload: ExecutionPayload,
    opts: SendOptions<W>,
  ): Promise<SendReturn<W>> {
    return BaseWallet.prototype.sendTx.call(this, executionPayload, opts) as Promise<SendReturn<W>>;
  }
}

// ── FPC test context ─────────────────────────────────────────────────

export interface FPCTestContext extends TestContext {
  fpc: SubscriptionFPC;
  fpcInstance: ContractInstanceWithAddress;
  fpcSecretKey: Fr;
  userWallet: EmbeddedWallet;
}

/**
 * Publishes the standard AuthRegistry (contract class + canonical instance) and
 * registers its artifact with PXE.
 */
async function ensureAuthRegistryPublished(
  wallet: EmbeddedWallet,
  from: AztecAddress,
): Promise<void> {
  const { instance, contractClass } = await getStandardAuthRegistry();
  if (
    !(await wallet.getContractClassMetadata(contractClass.id)).isContractClassPubliclyRegistered
  ) {
    await (await publishContractClass(wallet, AuthRegistryArtifact)).send({ from });
  }
  if (!(await wallet.getContractMetadata(instance.address)).isContractPublished) {
    await publishInstance(wallet, instance).send({ from });
  }
  await wallet.registerContract(instance, AuthRegistryArtifact);
}

/**
 * Spins up a fresh in-process sandbox (anvil + L1 contracts + AztecNode),
 * derives the admin from the first initial test account, and deploys a
 * SubscriptionFPC whose address was included in the genesis pre-funded
 * set. No bridging step required.
 *
 * Each call picks a random salt so parallel suites can't collide.
 */
export async function setupTestContext(): Promise<FPCTestContext> {
  const admin = await deriveAdminAddress();
  const fpcSalt = Fr.random();
  const fpcAddress = await computeFpcAddress(admin, fpcSalt);

  const network = await setupLocalNetwork({
    fundedAddresses: [admin, fpcAddress],
  });

  // The in-process network runs the AutomineSequencer, whose congestion fee
  // swings between estimate and inclusion; pad each wallet's max fee so txs
  // don't bounce off `maxFeesPerGas < gasFees`. See TEST_FEE_PADDING.
  const createWallet = async (): Promise<EmbeddedWallet> => {
    const wallet = await EmbeddedWallet.create(network.node, { ephemeral: true });
    wallet.setMinFeePadding(TEST_FEE_PADDING);
    return wallet;
  };

  const wallet = await createWallet();
  const [testAccount] = await getInitialTestAccountsData();
  // Create the admin's initializerless schnorr account in the wallet. These
  // accounts need no deployment tx — creating one registers the instance and
  // materializes its immutable signing key locally, and it's funded via genesis
  // at its address (the same address `deriveAdminAddress` pre-funds above).
  await createFundedInitializerlessAccounts(wallet, [testAccount]);

  // AuthRegistry is no longer a genesis protocol contract — publish it so the
  // public authwit path (sponsored `transfer_in_public`) can dispatch into it.
  await ensureAuthRegistryPublished(wallet, admin);

  const feeJuice = FeeJuiceContract.at(wallet);

  // Deploy with the same (secret, salt) the genesis pre-fund used.
  const { publicKeys } = await deriveKeys(FPC_SECRET_KEY);
  const deployMethod = await SubscriptionFPC.deploy(wallet, admin, {
    publicKeys,
    deployer: admin,
    salt: fpcSalt,
  });
  const instance = await deployMethod.getInstance();
  await wallet.registerContract(instance, SubscriptionFPC.artifact, FPC_SECRET_KEY);

  const { contract: rawFpc } = await deployMethod.send({
    from: admin,
  });
  const fpc = new SubscriptionFPC(rawFpc);

  return {
    node: network.node,
    wallet,
    admin,
    feeJuice,
    fpc,
    fpcInstance: instance,
    fpcSecretKey: FPC_SECRET_KEY,
    userWallet: await createWallet(),
    stop: network.stop,
  };
}

// ── Gas measurement helpers ──────────────────────────────────────────

export interface GasValues {
  gasLimits: { daGas: number; l2Gas: number };
  teardownGasLimits: { daGas: number; l2Gas: number };
}

/**
 * Maps the raw gas a simulation reports (`SimulationResult.gasUsed`, available
 * when `includeMetadata: true`) into our {@link GasValues} shape. The nightly
 * dropped the `fee.estimateGas` → `estimatedGas{gasLimits,...}` simulate API in
 * favor of surfacing raw consumed gas; for an overhead *measurement* the raw
 * `totalGas`/`teardownGas` is exactly what we want (no padding noise).
 */
export function toGas(gasUsed: {
  totalGas: { daGas: bigint | number; l2Gas: bigint | number };
  teardownGas: { daGas: bigint | number; l2Gas: bigint | number };
}): GasValues {
  return {
    gasLimits: {
      daGas: Number(gasUsed.totalGas.daGas),
      l2Gas: Number(gasUsed.totalGas.l2Gas),
    },
    teardownGasLimits: {
      daGas: Number(gasUsed.teardownGas.daGas),
      l2Gas: Number(gasUsed.teardownGas.l2Gas),
    },
  };
}

export function logGas(label: string, gas: GasValues) {
  console.log(
    `  ${label}: DA=${gas.gasLimits.daGas}  L2=${gas.gasLimits.l2Gas}  teardown(DA=${gas.teardownGasLimits.daGas} L2=${gas.teardownGasLimits.l2Gas})`,
  );
}
