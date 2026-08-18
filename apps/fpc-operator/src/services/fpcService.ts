import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { FunctionSelector } from "@aztec/aztec.js/abi";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { EmbeddedWallet } from "@aztec-kit/embedded-wallet";
import {
  SubscriptionFPCContract,
  SubscriptionFPCContractArtifact,
} from "@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC";
import { countAvailableSeats } from "@aztec-kit/contracts-aztec/seat-picker";

// ── localStorage keys ────────────────────────────────────────────────

const FPC_ADDRESS_KEY = "gofpc_fpc_address";
const FPC_SALT_KEY = "gofpc_fpc_salt";
const FPC_DEPLOYED_KEY = "gofpc_fpc_deployed";
const SIGNED_UP_APPS_KEY = "gofpc_fpc_apps";

// ── Stored FPC state ─────────────────────────────────────────────────

export interface StoredFPC {
  address: string;
  salt: string;
  deployed: boolean;
}

export function getStoredFPC(): StoredFPC | null {
  try {
    const address = localStorage.getItem(FPC_ADDRESS_KEY);
    const salt = localStorage.getItem(FPC_SALT_KEY);
    if (address && salt)
      return {
        address,
        salt,
        deployed: localStorage.getItem(FPC_DEPLOYED_KEY) === "true",
      };
  } catch {
    // ignore malformed localStorage entries
  }
  return null;
}

function storeFPC(address: string, salt: string) {
  localStorage.setItem(FPC_ADDRESS_KEY, address);
  localStorage.setItem(FPC_SALT_KEY, salt);
}

function markFPCDeployed() {
  localStorage.setItem(FPC_DEPLOYED_KEY, "true");
}

// ── Signed-up app configs ────────────────────────────────────────────

export interface SignedUpApp {
  appAddress: string;
  functionSelector: string;
  configIndex: number;
  maxUses: number;
  maxFee: string;
  maxUsers: number;
  /**
   * Sponsored fn's own gas limits (no FPC overhead). Runtime callers add
   * the subscribe/sponsor overhead at call time; swap persists this into
   * its network config so the helpers can size each tx.
   */
  gasLimits: { daGas: number; l2Gas: number };
  /**
   * Whether the sponsored call enqueues a public phase. Detected at
   * calibration. Runtime needs it to pick the correct FPC overhead
   * constant (PUBLIC vs PRIVATE variant).
   */
  hasPublicCall: boolean;
  createdAt: number;
}

export function getSignedUpApps(): SignedUpApp[] {
  try {
    const raw = localStorage.getItem(SIGNED_UP_APPS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveSignedUpApps(apps: SignedUpApp[]) {
  localStorage.setItem(SIGNED_UP_APPS_KEY, JSON.stringify(apps));
}

export function addSignedUpApp(app: SignedUpApp) {
  const apps = getSignedUpApps();
  apps.push(app);
  saveSignedUpApps(apps);
}

// ── Restore / clear FPC state ────────────────────────────────────────

export function restoreFPC(data: StoredFPC): void {
  localStorage.setItem(FPC_ADDRESS_KEY, data.address);
  localStorage.setItem(FPC_SALT_KEY, data.salt);
  localStorage.setItem(FPC_DEPLOYED_KEY, data.deployed ? "true" : "false");
}

export function clearFPC(): void {
  localStorage.removeItem(FPC_ADDRESS_KEY);
  localStorage.removeItem(FPC_SALT_KEY);
  localStorage.removeItem(FPC_DEPLOYED_KEY);
  localStorage.removeItem(SIGNED_UP_APPS_KEY);
}

// ── Config ID computation (matches Noir contract) ────────────────────

export async function computeConfigId(
  appAddress: AztecAddress,
  selector: FunctionSelector,
  configIndex: number,
): Promise<Fr> {
  return poseidon2Hash([appAddress.toField(), selector.toField(), new Fr(configIndex)]);
}

// ── FPC preparation + deployment ─────────────────────────────────────

/**
 * Pre-computes the FPC address without deploying. The address is deterministic
 * from the admin address and salt, so it can be funded before deployment.
 * Stores the FPC salt in localStorage for later deployment. The FPC owns no
 * notes, so it deploys with default contract keys.
 */
export async function prepareFPC(
  wallet: EmbeddedWallet,
  adminAddress: AztecAddress,
): Promise<{ fpcAddress: AztecAddress }> {
  const stored = getStoredFPC();
  if (stored) {
    // Re-register on reload (PXE state doesn't persist across browser sessions)
    const fpcAddress = AztecAddress.fromStringUnsafe(stored.address);
    const salt = Fr.fromString(stored.salt);
    const meta = await wallet.getContractMetadata(fpcAddress);
    if (!meta.instance) {
      const deployment = SubscriptionFPCContract.deploy(wallet, adminAddress, {
        salt,
        deployer: adminAddress,
      });
      const instance = await deployment.getInstance();
      await wallet.registerContract(instance, SubscriptionFPCContractArtifact);
    }
    return { fpcAddress };
  }

  const salt = Fr.random();

  const deployment = SubscriptionFPCContract.deploy(wallet, adminAddress, {
    salt,
    deployer: adminAddress,
  });
  const instance = await deployment.getInstance();

  await wallet.registerContract(instance, SubscriptionFPCContractArtifact);

  storeFPC(instance.address.toString(), salt.toString());

  return { fpcAddress: instance.address };
}

/**
 * Deploys the FPC contract on-chain. Must call prepareFPC first.
 * The admin account must have fee juice to pay for the deployment tx.
 */
export async function deployFPC(
  wallet: EmbeddedWallet,
  adminAddress: AztecAddress,
): Promise<{ fpcAddress: AztecAddress }> {
  const stored = getStoredFPC();
  if (!stored) throw new Error("Call prepareFPC first");

  const salt = Fr.fromString(stored.salt);

  const deployment = SubscriptionFPCContract.deploy(wallet, adminAddress, {
    salt,
    deployer: adminAddress,
  });
  // getInstance caches, so passing the salt here ensures the same address
  await deployment.getInstance();

  await deployment.send({ from: adminAddress });
  markFPCDeployed();

  return { fpcAddress: AztecAddress.fromStringUnsafe(stored.address) };
}

// ── Load existing FPC ────────────────────────────────────────────────

export async function loadExistingFPC(
  wallet: EmbeddedWallet,
  node: AztecNode,
  stored: StoredFPC,
): Promise<SubscriptionFPCContract> {
  const address = AztecAddress.fromStringUnsafe(stored.address);

  // Check if already registered locally in PXE
  const metadata = await wallet.getContractMetadata(address);
  if (!metadata.instance) {
    // Fetch the publicly deployed instance from the node
    const instance = await node.getContract(address);
    if (!instance) {
      throw new Error(
        `FPC contract at ${address.toString()} not found on-chain. It may need to be redeployed.`,
      );
    }
    await wallet.registerContract(instance, SubscriptionFPCContractArtifact);
  }

  return SubscriptionFPCContract.at(address, wallet);
}

// ── Sign up an app ───────────────────────────────────────────────────

export interface SignUpParams {
  appAddress: AztecAddress;
  selector: FunctionSelector;
  configIndex: number;
  maxUses: number;
  maxFee: bigint;
  maxUsers: number;
  gasLimits: { daGas: number; l2Gas: number };
  hasPublicCall: boolean;
}

export async function signUpApp(
  fpc: SubscriptionFPCContract,
  adminAddress: AztecAddress,
  params: SignUpParams,
) {
  await fpc.methods
    .sign_up(
      params.appAddress,
      params.selector,
      params.configIndex,
      params.maxUses,
      params.maxFee,
      params.maxUsers,
    )
    .send({ from: adminAddress, additionalScopes: [fpc.address] });

  addSignedUpApp({
    appAddress: params.appAddress.toString(),
    functionSelector: params.selector.toString(),
    configIndex: params.configIndex,
    maxUses: params.maxUses,
    maxFee: params.maxFee.toString(),
    maxUsers: params.maxUsers,
    gasLimits: params.gasLimits,
    hasPublicCall: params.hasPublicCall,
    createdAt: Date.now(),
  });
}

// ── Query seat availability ──────────────────────────────────────────

export async function queryAvailableSeats(
  node: AztecNode,
  fpcAddress: AztecAddress,
  configId: Fr,
  maxUsers: number,
): Promise<number> {
  try {
    return await countAvailableSeats({ node, fpcAddress, configId, maxUsers });
  } catch (err) {
    console.error("queryAvailableSeats failed:", err);
    return -1;
  }
}

// ── Query subscription info ──────────────────────────────────────────

export async function querySubscriptionInfo(
  fpc: SubscriptionFPCContract,
  user: AztecAddress,
  configId: Fr,
): Promise<{ hasSubscription: boolean; remainingUses: number }> {
  const { result } = await fpc.methods
    .get_subscription_info(user, configId)
    .simulate({ from: fpc.address });
  return {
    hasSubscription: result[0] as boolean,
    remainingUses: Number(result[1]),
  };
}
