/**
 * Fee handling for the deploy framework. Each account pays per its own {@link FeePolicy} — which
 * may override the spec-wide default:
 *
 * - `sponsored`  → a SponsoredFPC pays (local networks). All sponsored accounts share one method.
 * - `fee-juice`  → the account pays from its own Fee Juice; if below `threshold` with work to do,
 *   bridge `fundAmount` from L1. The bridge claim is single-use: the first paying tx claims it
 *   (`FeeJuicePaymentMethodWithClaim`) and the rest spend the balance. Pending claims are persisted
 *   (see ./state.ts) so a crash between bridge and claim resumes.
 */
import { Fr } from "@aztec/aztec.js/fields";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { GasFees } from "@aztec/stdlib/gas";
import {
  SponsoredFeePaymentMethod,
  FeeJuicePaymentMethodWithClaim,
  type FeePaymentMethod,
} from "@aztec/aztec.js/fee";
import { FeeJuiceContract } from "@aztec/aztec.js/protocol";
import { SponsoredFPCContractArtifact } from "@aztec/noir-contracts.js/SponsoredFPC";
import { SPONSORED_FPC_SALT } from "@aztec/constants";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import type { Wallet } from "@aztec/aztec.js/wallet";

import { bridge } from "../bridging/index.ts";
import { L1_DEFAULTS, bridgeMode, resolveL1Funder, type NetworkName } from "../testing/network-config.ts";
import type { DeployReporter, AccountFunding } from "./reporter.ts";
import type { DeployState } from "./state.ts";
import type { FeePolicy } from "./types.ts";

/** The `fee` field of a send-options object. */
export interface SendFee {
  paymentMethod?: FeePaymentMethod;
  gasSettings?: { maxFeesPerGas: GasFees };
}

/** Sane fee defaults: local pays via SponsoredFPC; remote networks pay from bridged Fee Juice. */
export function networkFeeDefaults(network: NetworkName): FeePolicy {
  if (network === "local") return { kind: "sponsored" };
  return {
    kind: "fee-juice",
    threshold: 100n * 10n ** 18n, // 100 FJ
    fundAmount: 1000n * 10n ** 18n, // 1000 FJ (non-faucet fallback amount)
  };
}

/**
 * Resolves an account's funding posture under `policy` — what the plan reports and what
 * {@link prepareFeeSession} acts on. `idle` accounts (no pending work) are never funded; sponsored
 * accounts never read a balance; fee-juice accounts are `funded` iff their balance clears the
 * threshold, else `not-funded` (a bridge will top them up).
 */
export async function accountFunding(
  policy: FeePolicy,
  wallet: Wallet,
  account: AztecAddress,
  hasWork: boolean,
): Promise<AccountFunding> {
  if (!hasWork) return { kind: "idle" };
  if (policy.kind === "sponsored") return { kind: "sponsored" };
  const feeJuice = FeeJuiceContract.at(wallet);
  const { result } = await feeJuice.methods.balance_of_public(account).simulate({ from: account });
  const balance = BigInt(result.toString());
  return balance >= policy.threshold
    ? { kind: "funded", balance }
    : { kind: "not-funded", balance, fundAmount: policy.fundAmount };
}

export interface FeeSession {
  /**
   * Fee options for the next tx from `account`, plus `onConsumed` to call after it lands (clears a
   * one-time bridge claim from persisted state). Subsequent calls pay from balance.
   */
  next(account: AztecAddress): { fee: SendFee; onConsumed: () => void };
}

export interface PrepareFeeSessionOpts {
  network: NetworkName;
  node: AztecNode;
  wallet: Wallet;
  /**
   * Working accounts (those with pending work) with their resolved {@link FeePolicy} + funding (from
   * {@link accountFunding}) — so this function doesn't re-read balances.
   */
  accounts: { address: AztecAddress; policy: FeePolicy; funding: AccountFunding }[];
  state: DeployState;
  persist: () => void;
  reporter: DeployReporter;
}

/**
 * Resolves fees ahead of execution, per account: registers the shared SponsoredFPC (for sponsored
 * accounts), or tops up a fee-juice account via a bridge (reusing a persisted pending claim when
 * present). Returns a {@link FeeSession} that dispenses the right fee per tx, by sending account.
 */
export async function prepareFeeSession(opts: PrepareFeeSessionOpts): Promise<FeeSession> {
  const { network, node, wallet, accounts, state, persist, reporter } = opts;
  const dispensers = new Map<string, () => { fee: SendFee; onConsumed: () => void }>();

  // Shared sponsored payment method: register the SponsoredFPC + read gas once, if anyone uses it.
  let sponsoredFee: SendFee | undefined;
  if (accounts.some((a) => a.policy.kind === "sponsored")) {
    const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
      salt: new Fr(SPONSORED_FPC_SALT),
    });
    await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
    sponsoredFee = {
      paymentMethod: new SponsoredFeePaymentMethod(sponsoredFPC.address),
      gasSettings: { maxFeesPerGas: (await node.getCurrentMinFees()).mul(10) },
    };
  }

  for (const { address, policy, funding } of accounts) {
    const key = address.toString();

    if (policy.kind === "sponsored") {
      dispensers.set(key, () => ({ fee: sponsoredFee ?? {}, onConsumed: () => {} }));
      continue;
    }

    // fee-juice: a single-use claim when not already funded — reuse a persisted one, else bridge.
    let claim: FeeJuicePaymentMethodWithClaim | undefined;
    if (funding.kind !== "funded") {
      const stored = state.pendingClaims[key];
      if (stored) {
        reporter.onBridge?.({ recipient: address, amount: BigInt(stored.claimAmount), reused: true });
        claim = new FeeJuicePaymentMethodWithClaim(address, {
          claimAmount: BigInt(stored.claimAmount),
          claimSecret: Fr.fromString(stored.claimSecret),
          messageLeafIndex: BigInt(stored.messageLeafIndex),
        });
      } else {
        reporter.onBridge?.({ recipient: address, amount: policy.fundAmount, reused: false });
        const { claim: bridged } = await bridge({
          node,
          recipient: address,
          // Caller-supplied, else the network's default funder: the anvil dev key on local (the L1
          // faucet `mint` is owner-gated there, so an ephemeral key is rejected), or — on testnet —
          // `L1_FUNDER_KEY` if set, otherwise an ephemeral key + the public faucet.
          l1RpcUrl: policy.l1RpcUrl ?? L1_DEFAULTS[network].l1RpcUrl,
          l1ChainId: L1_DEFAULTS[network].l1ChainId,
          amount: policy.fundAmount,
          l1PrivateKey: policy.l1FunderKey ?? resolveL1Funder(network),
          mode: bridgeMode(network),
        });
        // Persist before consuming, so a crash before the claim tx resumes from here.
        state.pendingClaims[key] = {
          claimAmount: bridged.claimAmount.toString(),
          claimSecret: bridged.claimSecret.toString(),
          messageLeafIndex: bridged.messageLeafIndex.toString(),
        };
        persist();
        claim = new FeeJuicePaymentMethodWithClaim(address, bridged);
      }
    }

    let claimConsumed = false;
    dispensers.set(key, () => {
      if (claim && !claimConsumed) {
        claimConsumed = true;
        return {
          fee: { paymentMethod: claim },
          onConsumed: () => {
            delete state.pendingClaims[key];
            persist();
          },
        };
      }
      return { fee: {}, onConsumed: () => {} }; // pay from balance
    });
  }

  return {
    next: (account) => {
      const dispenser = dispensers.get(account.toString());
      return dispenser ? dispenser() : { fee: {}, onConsumed: () => {} };
    },
  };
}
