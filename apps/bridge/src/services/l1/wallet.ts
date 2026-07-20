import type { EIP1193Provider, Hex } from "viem";

/**
 * Thin EIP-1193 helpers. Every function takes the provider of the wallet the
 * user selected (see `discovery.ts`) — never ambient `window.ethereum`, which
 * with several extensions installed belongs to whichever one won the
 * injection race, not necessarily the wallet the user connected.
 */

// Workaround: viem 2.47's typed `request` generics degrade for parameterless
// methods under this TS setup (same family of issue as `viemReadContract` in
// clients.ts) — widen the signature once here and cast results.
type Eip1193Request = (args: { method: string; params?: unknown }) => Promise<unknown>;
const rpc = (provider: EIP1193Provider) => provider.request as Eip1193Request;

export async function switchChain(provider: EIP1193Provider, chainId: number): Promise<void> {
  try {
    await rpc(provider)({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
  } catch (err: unknown) {
    const error = err as { code?: number };
    if (error.code === 4902) {
      throw new Error(`Chain ${chainId} not configured in your wallet. Please add it manually.`);
    }
    throw err;
  }
}

export async function getConnectedAccount(provider: EIP1193Provider): Promise<Hex | null> {
  try {
    const accounts = (await rpc(provider)({ method: "eth_accounts" })) as Hex[];
    return accounts[0] ?? null;
  } catch {
    return null;
  }
}

export async function connectWallet(provider: EIP1193Provider): Promise<Hex> {
  const accounts = (await rpc(provider)({ method: "eth_requestAccounts" })) as Hex[];
  if (!accounts[0]) throw new Error("No account returned");
  return accounts[0];
}

/** Returns the wallet's current chain ID, or null if unavailable. */
export async function getWalletChainId(provider: EIP1193Provider): Promise<number | null> {
  try {
    const chainIdHex = (await rpc(provider)({ method: "eth_chainId" })) as string;
    return parseInt(chainIdHex, 16);
  } catch {
    return null;
  }
}

/**
 * Opens the wallet's account picker so the user can switch accounts.
 * Returns the newly selected account address.
 */
export async function requestAccountSwitch(provider: EIP1193Provider): Promise<Hex> {
  await rpc(provider)({
    method: "wallet_requestPermissions",
    params: [{ eth_accounts: {} }],
  });
  // After permission grant, read accounts to get the selected one
  const accounts = (await rpc(provider)({ method: "eth_accounts" })) as Hex[];
  if (!accounts[0]) throw new Error("No account selected");
  return accounts[0];
}

/**
 * Revokes the wallet connection permission (MetaMask EIP-2255).
 * Falls back to a no-op on wallets that don't support it.
 */
export async function revokeWalletPermissions(provider: EIP1193Provider): Promise<void> {
  try {
    await rpc(provider)({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    // Not all wallets support revokePermissions — clearing local state is enough
  }
}
