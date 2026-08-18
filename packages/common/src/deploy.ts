/**
 * Façade over the deploy framework plus the kit's network glue.
 *
 * The framework is upstream — `@aztec/aztec/deploy`, shipped since 5.2.0. It lived vendored under
 * `./deploy/` until that subpath existed; this file is now the only place that names it, so a
 * future move is still a one-file change.
 */
import { join } from "node:path";

import {
  defaultFeePolicy,
  runDeployment,
  type DeploymentSpec,
  type FeePolicy,
  type Steps,
} from "@aztec/aztec/deploy";
import { createNode } from "./node/create-node.ts";
import {
  apiKeyForNetwork,
  L1_DEFAULTS,
  NETWORK_URLS,
  resolveL1Funder,
  type NetworkName,
} from "./testing/network-config.ts";

export * from "@aztec/aztec/deploy";

/**
 * Fills a fee policy's L1 fields from the kit's per-network defaults: RPC/chain id from
 * {@link L1_DEFAULTS} and the funder key via {@link resolveL1Funder} (env-driven — this is the
 * caller-side config layer the framework itself never touches).
 */
export function networkFeePolicy(network: NetworkName, base?: FeePolicy): FeePolicy {
  const policy = base ?? defaultFeePolicy(network === "local");
  if (policy.kind !== "fee-juice") return policy;
  return {
    ...policy,
    l1RpcUrl: policy.l1RpcUrl ?? L1_DEFAULTS[network].l1RpcUrl,
    l1ChainId: policy.l1ChainId ?? L1_DEFAULTS[network].l1ChainId,
    l1FunderKey: policy.l1FunderKey ?? resolveL1Funder(network),
  };
}

/** {@link DeploymentSpec} with the kit's network name in place of the framework's target fields. */
export interface NetworkDeploymentSpec<C extends Steps = Steps> extends Omit<
  DeploymentSpec<C>,
  "local" | "label" | "node"
> {
  network: NetworkName;
  /**
   * The node to deploy against — a JSON-RPC URL or a connected node. Defaults to the network's
   * entry in {@link NETWORK_URLS}.
   */
  node?: DeploymentSpec<C>["node"];
}

/**
 * Runs a deployment against a named kit network: maps the network to the framework's target fields
 * (`local`/`label`/`node`), scopes the resume state per network (`<stateDir>/<network>/`), and
 * fills network L1 defaults into every fee policy and fund step.
 */
export function runNetworkDeployment<C extends Steps>(
  spec: NetworkDeploymentSpec<C>,
): Promise<void> {
  const { network, ...rest } = spec;
  const steps = Object.fromEntries(
    Object.entries(spec.steps).map(([alias, step]) => [
      alias,
      step.kind === "fund"
        ? {
            ...step,
            l1RpcUrl: step.l1RpcUrl ?? L1_DEFAULTS[network].l1RpcUrl,
            l1ChainId: step.l1ChainId ?? L1_DEFAULTS[network].l1ChainId,
            l1FunderKey: step.l1FunderKey ?? resolveL1Funder(network),
          }
        : step,
    ]),
  ) as C;
  // Handed a URL, the framework builds its own node client — and that client sends no API
  // key, so it 403s against a gateway-fronted network. Give it a connected node instead
  // whenever a key is configured. Without one we keep passing the URL through: the runner
  // exposes the debug API (local time-warping during a bridge) only when it was given one.
  const target = spec.node ?? NETWORK_URLS[network];
  const apiKey = apiKeyForNetwork(network);

  return runDeployment({
    ...rest,
    local: network === "local",
    label: network,
    node: typeof target === "string" && apiKey ? createNode(target, apiKey) : target,
    stateDir: join(spec.stateDir ?? join(process.cwd(), ".deploy-state"), network),
    fees: networkFeePolicy(network, spec.fees),
    accounts: Object.fromEntries(
      Object.entries(spec.accounts).map(([alias, account]) => [
        alias,
        account.fees ? { ...account, fees: networkFeePolicy(network, account.fees) } : account,
      ]),
    ),
    steps,
  });
}
