/**
 * Local subscribe-vs-sponsor hint for the SubscriptionFPC.
 *
 * The FPC's `sponsor` requires a `SubscriptionNote` at
 * `config_id = hash(app, selector, configIndex)`, so the key is per
 * (fpc, app, selector, configIndex, user). This is only a hint to skip a
 * redundant subscribe; the FPC is the source of truth. Dependency-free
 * (localStorage only) so it's unit-testable without the @aztec runtime.
 */

const SUBSCRIPTION_KEY = "goswap_subscriptions";

export function subscriptionKey(
  fpcAddress: string,
  appAddress: string,
  selector: string,
  configIndex: number,
  userAddress: string,
): string {
  return `${fpcAddress}:${appAddress}:${selector}:${configIndex}:${userAddress}`;
}

export function hasSubscription(
  fpcAddress: string,
  appAddress: string,
  selector: string,
  configIndex: number,
  userAddress: string,
): boolean {
  try {
    const subs = JSON.parse(localStorage.getItem(SUBSCRIPTION_KEY) ?? "{}");
    return !!subs[subscriptionKey(fpcAddress, appAddress, selector, configIndex, userAddress)];
  } catch {
    return false;
  }
}

export function markSubscribed(
  fpcAddress: string,
  appAddress: string,
  selector: string,
  configIndex: number,
  userAddress: string,
) {
  try {
    const subs = JSON.parse(localStorage.getItem(SUBSCRIPTION_KEY) ?? "{}");
    subs[subscriptionKey(fpcAddress, appAddress, selector, configIndex, userAddress)] = true;
    localStorage.setItem(SUBSCRIPTION_KEY, JSON.stringify(subs));
  } catch {
    /* ignore */
  }
}
