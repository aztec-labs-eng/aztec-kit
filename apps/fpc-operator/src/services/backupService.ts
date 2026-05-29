import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { EmbeddedWallet } from "@aztec-kit/embedded-wallet";
import {
  getStoredFPC,
  getSignedUpApps,
  saveSignedUpApps,
  restoreFPC,
  clearFPC,
  type SignedUpApp,
  type StoredFPC,
} from "./fpcService";

// ── Backup format ────────────────────────────────────────────────────

// v2 (current): admin.salt is the plain contract instance salt.
//
// v1 (pre AZIP-9 immutables_hash migration): admin.salt held the `actualSalt`
// of the old salt-abuse pattern; the contract address was derived from
// `salt = hash(actualSalt, signingKey)` with `immutablesHash = 0`. The new
// address derivation folds `immutablesHash` into the salted initialization
// hash, so v1 keys can't be restored to the same address — rejected on import.
const BACKUP_VERSION = 2;
const NETWORK_KEY = "aztec_kit_network";

export interface BackupData {
  version: number;
  exportedAt: string;
  network: string | null;
  admin: {
    secretKey: string;
    salt: string;
    address: string;
  };
  fpc: StoredFPC | null;
  apps: SignedUpApp[];
}

// ── Export ────────────────────────────────────────────────────────────

export async function exportBackup(wallet: EmbeddedWallet, address: AztecAddress): Promise<void> {
  const { secretKey, salt } = await wallet.getAccountData(address);

  const fpc = getStoredFPC();
  const apps = getSignedUpApps();

  const data: BackupData = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    network: localStorage.getItem(NETWORK_KEY),
    admin: {
      secretKey: secretKey.toString(),
      salt: salt.toString(),
      address: address.toString(),
    },
    fpc,
    apps,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const date = new Date().toISOString().slice(0, 10);
  a.download = `gofpc-backup-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Parse & validate ─────────────────────────────────────────────────

function isValidHex(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value);
}

export async function parseAndValidateBackup(
  file: File,
): Promise<{ data: BackupData; errors?: undefined } | { data?: undefined; errors: string[] }> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { errors: ["Failed to read file"] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errors: ["Invalid JSON"] };
  }

  const errors: string[] = [];
  const obj = parsed as Record<string, unknown>;

  if (obj.version !== BACKUP_VERSION) {
    if (obj.version === 1) {
      errors.push(
        "This backup was created before the immutables_hash migration. The admin account it points to can't be restored to the same address under the current derivation — create a fresh account and re-bind your FPC.",
      );
    } else {
      errors.push(`Unsupported backup version: ${obj.version} (expected ${BACKUP_VERSION})`);
    }
  }

  const admin = obj.admin as Record<string, unknown> | undefined;
  if (!admin || typeof admin !== "object") {
    errors.push("Missing admin section");
  } else {
    if (!isValidHex(admin.secretKey)) errors.push("Invalid admin.secretKey");
    if (!isValidHex(admin.salt)) errors.push("Invalid admin.salt");
  }

  if (errors.length > 0) return { errors };

  return { data: obj as unknown as BackupData };
}

// ── Apply ────────────────────────────────────────────────────────────

export async function applyBackup(wallet: EmbeddedWallet, data: BackupData): Promise<void> {
  // Remove current account
  await wallet.deleteStoredAccount();

  // Clear current FPC data
  clearFPC();

  // Recreate admin account from backup keys
  await wallet.createInitializerlessAccount(
    Fr.fromString(data.admin.secretKey),
    Fr.fromString(data.admin.salt),
  );

  // Restore FPC if present
  if (data.fpc) {
    restoreFPC(data.fpc);
  }

  // Restore signed-up apps
  if (data.apps?.length) {
    saveSignedUpApps(data.apps);
  }

  // Reload to reinitialize everything from clean state
  window.location.reload();
}
