import type { EIP1193Provider } from "viem";

/**
 * EIP-6963 (Multi Injected Provider Discovery) wallet store.
 *
 * Wallet extensions announce themselves via `eip6963:announceProvider`
 * window events, which sidesteps the `window.ethereum` injection race
 * entirely: every installed wallet is discoverable, and the app talks to
 * the provider object the user actually picked.
 *
 * This module is the ONLY place allowed to touch `window.ethereum`
 * (as a fallback for pre-EIP-6963 wallets). Everything else receives an
 * `EIP1193Provider` explicitly.
 *
 * Shaped for React's `useSyncExternalStore`: `subscribeWallets` +
 * `getWalletsSnapshot` (snapshot is referentially stable between changes).
 */

export interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  /** Data-URI icon, per spec. */
  icon: string;
  /** Reverse-DNS wallet identifier, e.g. `io.metamask` — stable across sessions. */
  rdns: string;
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
}

/** rdns assigned to the legacy `window.ethereum` fallback entry. */
export const LEGACY_WALLET_RDNS = "legacy.window.ethereum";

const GENERIC_WALLET_ICON =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="3" fill="%23667"/><circle cx="17" cy="12" r="1.6" fill="%23fff"/></svg>';

const providers = new Map<string, EIP6963ProviderDetail>();
const subscribers = new Set<() => void>();
let snapshot: EIP6963ProviderDetail[] = [];
let started = false;

function emit() {
  snapshot = [...providers.values()];
  for (const notify of subscribers) notify();
}

function handleAnnounce(event: Event) {
  const detail = (event as CustomEvent<EIP6963ProviderDetail>).detail;
  if (!detail?.info?.rdns || typeof detail.provider?.request !== "function") return;
  // A 6963-capable wallet supersedes the legacy fallback when both wrap the
  // same provider object.
  const legacy = providers.get(LEGACY_WALLET_RDNS);
  if (legacy && legacy.provider === detail.provider) providers.delete(LEGACY_WALLET_RDNS);
  providers.set(detail.info.rdns, detail);
  emit();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("eip6963:announceProvider", handleAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // Announcements are synchronous per spec, so anything still missing after
  // the dispatch only exists as `window.ethereum` (pre-EIP-6963 wallet).
  const injected = (window as { ethereum?: EIP1193Provider }).ethereum;
  if (providers.size === 0 && typeof injected?.request === "function") {
    providers.set(LEGACY_WALLET_RDNS, {
      info: {
        uuid: LEGACY_WALLET_RDNS,
        name: "Browser Wallet",
        icon: GENERIC_WALLET_ICON,
        rdns: LEGACY_WALLET_RDNS,
      },
      provider: injected,
    });
    emit();
  }
}

export function subscribeWallets(onChange: () => void): () => void {
  start();
  subscribers.add(onChange);
  return () => subscribers.delete(onChange);
}

export function getWalletsSnapshot(): EIP6963ProviderDetail[] {
  start();
  return snapshot;
}
