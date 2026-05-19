import type { AccountType } from "@aztec/wallets/embedded";

/**
 * Account type tag for the initializerless Schnorr account. Cast through
 * `AccountType` for storage in `WalletDB` (the upstream string-union doesn't
 * include this value, but the DB stores it as a raw string).
 */
export const INITIALIZERLESS_TYPE = "schnorr-initializerless" as AccountType;
