/**
 * Signs up the swap app's sponsored functions to an already-deployed
 * SubscriptionFPC, optionally running P75-based calibration to pick a tight
 * `maxFee` per signup.
 *
 * Inputs:
 *   --network <local|testnet|nextnet>
 *   FPC_ADDRESS      — hex AztecAddress of the deployed FPC (from fpc-operator/deploy-fpc)
 *   FPC_ADMIN_SECRET — FPC admin secret (signup txs must be sent by the FPC deployer)
 *   FPC_SECRET       — the contract key secret the FPC was deployed with, so the
 *                      PXE can derive its public keys for note encoding during
 *                      calibration simulations. Published by deploy-fpc on stdout.
 *
 * Side outputs:
 *   Writes `subscriptionFPC.{address, secretKey, functions}` into the
 *   committed swap network config (`src/config/networks/<network>.json`).
 *   `functions` maps `contractAddress → { functionSelector → configIndex }`.
 *
 * Calibration behaviour:
 *   - `local`    : skipped. Uses the hardcoded `maxFee` fallback.
 *   - `testnet` : runs the FPC's `calibrate` helper to get gas limits, then
 *                  multiplies by the clustec P75-of-last-2000-blocks maxFeePerGas
 *                  with a 2× safety multiplier (what the dashboard UI does).
 */
import fs from "fs";
import path from "path";
import type { FunctionAbi, ContractArtifact } from "@aztec/aztec.js/abi";
import { Contract } from "@aztec/aztec.js/contracts";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { FunctionSelector } from "@aztec/stdlib/abi";
import { Fr } from "@aztec/foundation/curves/bn254";
import {
  SubscriptionFPCContract,
  SubscriptionFPCContractArtifact,
} from "@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC";
import { ProofOfPasswordContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/ProofOfPassword";
import { AMMContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/AMM";
import { TokenContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/Token";
import { SubscriptionFPC, fpcSubscribeOverhead } from "@aztec-kit/contracts-aztec/subscription-fpc";
import { Gas, ManaUsageEstimate } from "@aztec/stdlib/gas";
import {
  fetchFeeStats,
  computeMaxFeeFromP75,
  computeMaxFeeFromCurrent,
} from "@aztec-kit/common/fees";

import {
  parseNetwork,
  NETWORK_URLS,
  setupWallet,
  loadOrCreateSecret,
  getAdmin,
  getSalt,
  writeFpcAdminBackup,
  resolveFpcAdminBackupPath,
  type NetworkName,
  type SignedUpApp,
} from "@aztec-kit/common/testing";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

const P75_BLOCK_RANGE = 2000;
const P75_MULTIPLIER = 2;
/**
 * Multiplier applied when we fall back to the node's current min fees (clustec
 * indexer unavailable). The P75 already accounts for historical spread so 2×
 * is enough; current min fees are the floor right now with no headroom, so we
 * need a much wider buffer.
 */
const CURRENT_FEE_FALLBACK_MULTIPLIER = 20;

/** Default sponsorship policy; individual specs can override any field. */
const SIGNUP_POLICY = {
  maxUses: 100,
  maxUsers: 100,
  /** Used only when calibration is skipped (local dev flow). */
  localMaxFee: BigInt("1000000000000000000000"), // 1000 FJ
} as const;

type SampleArgsBuilder = (ctx: {
  admin: AztecAddress;
  contractAddress: AztecAddress;
  contracts: Record<string, AztecAddress>;
}) => unknown[];

interface SignupSpec {
  artifact: ContractArtifact;
  functionName: string;
  /** Aliases into `config.contracts` — each one produces a separate sign_up. */
  contractAlias: string[];
  /** Args to pass when simulating the call during calibration. */
  sampleArgs: SampleArgsBuilder;
  maxUses?: number;
  maxUsers?: number;
}

const PASSWORD = process.env.PASSWORD ?? "potato";

const SIGNUPS: SignupSpec[] = [
  {
    artifact: ProofOfPasswordContractArtifact,
    functionName: "check_password_and_mint",
    contractAlias: ["pop"],
    // Signature: (password: str<31>, to: AztecAddress). The calibration
    // simulate goes through subscribe → check_password_and_mint, which
    // hashes the password and asserts against the on-chain hash. Must
    // match whatever the contract was deployed with.
    sampleArgs: ({ admin }) => [PASSWORD, admin.toString()],
  },
  {
    artifact: AMMContractArtifact,
    functionName: "swap_tokens_for_exact_tokens_from",
    contractAlias: ["amm"],
    // Tokens need to be already minted to admin.
    sampleArgs: ({ admin, contracts }) => [
      admin.toString(),
      contracts.goCoin.toString(),
      contracts.goCoinPremium.toString(),
      10n,
      20n,
      1n,
    ],
  },
  {
    artifact: TokenContractArtifact,
    functionName: "transfer_in_private_deliver_offchain",
    contractAlias: ["goCoin", "goCoinPremium"],
    sampleArgs: ({ admin }) => [admin.toString(), admin.toString(), 10n, 0n],
  },
];

async function main() {
  const network = parseNetwork();
  const configPath = path.join(import.meta.dirname, `../src/config/networks/${network}.json`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

  const fpcAddress = AztecAddress.fromString(requireEnv("FPC_ADDRESS"));
  console.error(`Registering swap signups on FPC ${fpcAddress.toString()}...`);

  const { node, wallet, paymentMethod } = await setupWallet(NETWORK_URLS[network], network);
  // Signups must be sent by the FPC admin (who deployed the FPC), not the swap admin.
  // The FPC admin is deployed by `fpc-operator/scripts/deploy-admin.ts`.
  const { secretKey } = loadOrCreateSecret("FPC_ADMIN_SECRET");
  const admin = await getAdmin(
    wallet,
    secretKey,
    `Run \`yarn swap deploy-admin:${network}\` first.`,
  );

  // Hydrate the PXE with all swap contracts.
  const contracts = await registerSwapContracts(wallet, node, config.contracts);

  // Register the swap admin (the token's minter) as a sender on the FPC
  // admin's wallet so note-tag discovery finds the GoCoin notes that
  // were minted to the FPC admin during the `mint:<network>` step of the
  // setup orchestration. Without this, the AMM swap calibration can't see
  // its own balances and fails "Balance too low".
  const swapAdmin = AztecAddress.fromString(config.deployer.address);
  await wallet.registerSender(swapAdmin, "swap-admin");

  // Register the FPC contract so we can simulate subscribe() against it.
  const fpcInstance = await node.getContract(fpcAddress);
  if (!fpcInstance) throw new Error(`FPC ${fpcAddress.toString()} not found on-chain`);
  // The FPC's contract key secret is published by deploy-fpc (it's public by
  // design — the FPC holds notes for its slot tracking and the PXE needs its
  // keys to decode those notes during simulation).
  const fpcSecret = Fr.fromString(requireEnv("FPC_SECRET"));
  await wallet.registerContract(fpcInstance, SubscriptionFPCContractArtifact, fpcSecret);

  const fpc = new SubscriptionFPC(SubscriptionFPCContract.at(fpcAddress, wallet));

  const resolved = await resolveSignups(SIGNUPS, contracts);
  // Matches the shape the swap app expects at runtime:
  //   { [contractAddress]: { [functionSelector]: SubscriptionFunctionConfig } }.
  // See apps/swap/src/config/networks/index.ts. `gasLimits` is the sponsored
  // fn's own gas (no FPC overhead) — the helpers add the subscribe/sponsor
  // overhead at call time.
  const functions: Record<
    string,
    Record<
      string,
      {
        configIndex: number;
        gasLimits: { daGas: number; l2Gas: number };
        hasPublicCall: boolean;
      }
    >
  > = {};

  // Rows destined for the fpc-operator backup's `apps` array — same shape
  // the UI's Backup/Restore tab produces, so a script-written backup can be
  // imported back into the UI to hydrate the dashboard.
  const backupApps: SignedUpApp[] = [];

  for (const signup of resolved) {
    console.error(`\nSigning up ${signup.aliasKey}.${signup.functionName}...`);

    const { maxFee, gasLimits, hasPublicCall } = await pickSignupParams({
      network,
      node,
      fpc,
      wallet,
      admin,
      signup,
      contracts,
    });

    await fpc.contract.methods
      .sign_up(
        signup.contractAddress,
        signup.selector,
        0, // configIndex
        signup.maxUses,
        maxFee,
        signup.maxUsers,
      )
      .send({ from: admin, fee: { paymentMethod } });

    console.error(
      `  sign_up ok — maxFee=${maxFee} gasLimits=${gasLimits.daGas}/${gasLimits.l2Gas} hasPublicCall=${hasPublicCall}`,
    );

    const key = signup.contractAddress.toString();
    functions[key] = functions[key] ?? {};
    functions[key][signup.selector.toString()] = {
      configIndex: 0,
      gasLimits,
      hasPublicCall,
    };

    backupApps.push({
      appAddress: key,
      functionSelector: signup.selector.toString(),
      configIndex: 0,
      maxUses: signup.maxUses,
      maxFee: maxFee.toString(),
      maxUsers: signup.maxUsers,
      gasLimits,
      hasPublicCall,
      createdAt: Date.now(),
    });
  }

  config.subscriptionFPC = {
    ...(config.subscriptionFPC ?? {}),
    address: fpcAddress.toString(),
    secretKey: fpcSecret.toString(),
    functions,
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.error(`\nUpdated ${configPath} with subscriptionFPC.functions.`);

  // Layer the apps onto the fpc-operator backup file. Leaves `admin`/`fpc`
  // sections from `deploy-fpc.ts` intact via the helper's merge semantics.
  const backupPath = resolveFpcAdminBackupPath(network, import.meta.dirname);
  writeFpcAdminBackup({
    backupPath,
    network,
    admin: {
      secretKey: secretKey.toString(),
      salt: getSalt().toString(),
      address: admin.toString(),
    },
    fpc: {
      address: fpcAddress.toString(),
      secretKey: fpcSecret.toString(),
      salt: getSalt().toString(),
      deployed: true,
    },
    apps: backupApps,
  });
  console.error(`Updated ${backupPath} with ${backupApps.length} signed-up apps.`);
}

// ── Helpers ─────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`${name} env var is required`);
    process.exit(1);
  }
  return v;
}

async function registerSwapContracts(
  wallet: EmbeddedWallet,
  node: AztecNode,
  contracts: Record<string, string>,
): Promise<Record<string, AztecAddress>> {
  // Map alias → artifact so we can register everything the sample calls touch.
  const ARTIFACT_BY_ALIAS: Record<string, ContractArtifact> = {
    goCoin: TokenContractArtifact,
    goCoinPremium: TokenContractArtifact,
    liquidityToken: TokenContractArtifact,
    amm: AMMContractArtifact,
    pop: ProofOfPasswordContractArtifact,
  };

  const out: Record<string, AztecAddress> = {};
  for (const [alias, addressStr] of Object.entries(contracts)) {
    const artifact = ARTIFACT_BY_ALIAS[alias];
    if (!artifact) continue; // ignore config entries we don't know about (sponsoredFPC etc)
    const address = AztecAddress.fromString(addressStr);
    const instance = await node.getContract(address);
    if (!instance) {
      throw new Error(`Contract ${alias} (${addressStr}) not found on-chain`);
    }
    await wallet.registerContract(instance, artifact);
    out[alias] = address;
  }
  return out;
}

interface ResolvedSignup extends SignupSpec {
  aliasKey: string;
  contractAddress: AztecAddress;
  selector: FunctionSelector;
  maxUses: number;
  maxUsers: number;
}

async function resolveSignups(
  specs: SignupSpec[],
  contracts: Record<string, AztecAddress>,
): Promise<ResolvedSignup[]> {
  const out: ResolvedSignup[] = [];
  for (const spec of specs) {
    const fn = spec.artifact.functions.find((f: FunctionAbi) => f.name === spec.functionName);
    if (!fn) {
      throw new Error(`Function ${spec.functionName} not found in ${spec.artifact.name}`);
    }
    const selector = await FunctionSelector.fromNameAndParameters(fn.name, fn.parameters);
    for (const alias of spec.contractAlias) {
      const contractAddress = contracts[alias];
      if (!contractAddress) {
        throw new Error(`Alias ${alias} missing from config.contracts`);
      }
      out.push({
        ...spec,
        aliasKey: alias,
        contractAddress,
        selector,
        maxUses: spec.maxUses ?? SIGNUP_POLICY.maxUses,
        maxUsers: spec.maxUsers ?? SIGNUP_POLICY.maxUsers,
      });
    }
  }
  return out;
}

/**
 * Runs calibration and derives the signup params. Calibration measures the
 * sponsored fn's standalone gas, which we persist into the swap config so
 * runtime callers can add the appropriate FPC overhead. `maxFee` on
 * testnet is sized from the P75 of per-gas prices against the full
 * subscribe-path cost; on local it falls back to a hardcoded policy value
 * because there's no P75 feed. If clustec doesn't index the network (e.g.
 * nextnet today) we fall back to the node's current min fees × a wider
 * multiplier — matches the manual UI escape hatch the e2e test uses.
 */
async function pickSignupParams(params: {
  network: NetworkName;
  node: AztecNode;
  fpc: SubscriptionFPC;
  wallet: EmbeddedWallet;
  admin: AztecAddress;
  signup: ResolvedSignup;
  contracts: Record<string, AztecAddress>;
}): Promise<{
  maxFee: bigint;
  gasLimits: { daGas: number; l2Gas: number };
  hasPublicCall: boolean;
}> {
  const { network, node, fpc, wallet, admin, signup, contracts } = params;

  const contract = Contract.at(signup.contractAddress, signup.artifact, wallet);
  const args = signup.sampleArgs({
    admin,
    contractAddress: signup.contractAddress,
    contracts,
  });
  const sampleCall = await contract.methods[signup.functionName](...args).getFunctionCall();

  const calibrated = await fpc.helpers.calibrate({
    adminWallet: wallet,
    adminAddress: admin,
    sampleCall,
  });
  const gasLimits = { daGas: calibrated.daGas, l2Gas: calibrated.l2Gas };
  const hasPublicCall = calibrated.hasPublicCall;

  let maxFee: bigint;
  if (network === "local") {
    maxFee = SIGNUP_POLICY.localMaxFee;
  } else {
    // Size max_fee against the subscribe-path composite (standalone + FPC
    // subscribe overhead) — that's the worst case the slot needs to cover.
    const subscribeTotal = new Gas(gasLimits.daGas, gasLimits.l2Gas).add(
      fpcSubscribeOverhead(hasPublicCall),
    );
    const subscribeGas = {
      daGas: Number(subscribeTotal.daGas),
      l2Gas: Number(subscribeTotal.l2Gas),
    };
    const zeroTeardown = { daGas: 0, l2Gas: 0 };

    try {
      const stats = await fetchFeeStats(network, P75_BLOCK_RANGE);
      maxFee = computeMaxFeeFromP75(subscribeGas, zeroTeardown, stats, P75_MULTIPLIER);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `  clustec P75 fetch failed (${reason}); falling back to node predicted min fees × ${CURRENT_FEE_FALLBACK_MULTIPLIER}`,
      );
      const predicted = await node.getPredictedMinFees(ManaUsageEstimate.Limit);
      const worst = predicted.length
        ? predicted.reduce((acc, f) => (f.feePerL2Gas > acc.feePerL2Gas ? f : acc))
        : await node.getCurrentMinFees();
      maxFee = computeMaxFeeFromCurrent(
        subscribeGas,
        zeroTeardown,
        BigInt(worst.feePerDaGas),
        BigInt(worst.feePerL2Gas),
        CURRENT_FEE_FALLBACK_MULTIPLIER,
      );
    }
  }

  return { maxFee, gasLimits, hasPublicCall };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
