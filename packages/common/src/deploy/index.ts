/**
 * A minimal, declarative deployment framework for Aztec — "terraform for Aztec" (v0).
 *
 * Describe the accounts you send from and a graph of steps — contracts that must end up on-chain
 * (deterministic addresses, interdependencies via `initializerArgs`) and the txs to send — plus how
 * fees are paid; then {@link runDeployment} resolves, takes an on-chain inventory, funds, and
 * executes only what's missing in dependency order — idempotently and resumably. The framework
 * never reads the environment; callers pipe in secrets and config.
 */
export { runDeployment } from "./runner.ts";
export { consoleReporter } from "./reporter.ts";
export type {
  DeployReporter,
  DeployPlan,
  DeployPlanAccount,
  DeployPlanStep,
  AccountFunding,
  DeploySummary,
  DeployUnitInfo,
  DeployUnitResult,
  DeployUnitKind,
  BridgeEvent,
} from "./reporter.ts";
export type {
  DeploymentSpec,
  AccountSpec,
  ContractStep,
  ActionStep,
  StepSpec,
  Steps,
  ContractClass,
  FeePolicy,
  Resolver,
  Ctx,
} from "./types.ts";
