/**
 * Deploy the swap app (3 tokens, AMM, Proof-of-Password) with the declarative deploy
 * framework (`@aztec-kit/common/deploy`).
 *
 *   yarn swap deploy:local           # SponsoredFPC pays
 *   yarn swap deploy:testnet         # deployer pays from its own Fee Juice (bridges if low)
 *   yarn swap deploy:local --payment feejuice   # exercise the testnet fee path on local
 *
 * The deployer is an initializerless Schnorr account (no account-deploy tx). This file is the
 * *spec*: the contracts that must end up on-chain (deterministic addresses + interdependencies)
 * and the bootstrap txs; the framework resolves, inventories, funds, and executes only what's
 * missing, idempotently. `runSwapDeploy` stays importable (e2e/global-setup) and writes the
 * frontend's `src/config/networks/<network>.json`.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

import { Fr } from "@aztec/foundation/curves/bn254";
import { AztecAddress } from "@aztec/stdlib/aztec-address";

import { TokenContract } from "@aztec-kit/contracts-aztec/artifacts/Token";
import { AMMContract } from "@aztec-kit/contracts-aztec/artifacts/AMM";
import { ProofOfPasswordContract } from "@aztec-kit/contracts-aztec/artifacts/ProofOfPassword";

import { runDeployment } from "@aztec-kit/common/deploy";
import type { ActionStep, ContractStep, FeePolicy } from "@aztec-kit/common/deploy";
import {
  parseNetwork,
  parseAddressList,
  parsePaymentMode,
  NETWORK_URLS,
  loadOrCreateSecret,
  getSalt,
  getSponsoredFPCContract,
  type NetworkName,
  type PaymentMode,
} from "@aztec-kit/common/testing";

const INITIAL_TOKEN_BALANCE = 1_000_000_000n;
const ONE_FEE_JUICE = 10n ** 18n;

export interface SwapDeployOptions {
  network: NetworkName;
  /** If omitted, falls back to the per-network default. */
  paymentMode?: PaymentMode;
  /** Required. Used as the seed for the deterministic Proof-of-Password contract. */
  password: string;
  /**
   * Optional deterministic secret for the deployer account (hex-encoded Fr).
   * Falls back to `process.env.SWAP_ADMIN_SECRET`, then to a random key. For e2e runs
   * this should be the swap-admin secret derived by global-setup.
   */
  deployerSecret?: string;
  /** Extra L2 addresses to mint initial token balances to. */
  mintTo?: string[];
  /** If true, skips writing `src/config/networks/<network>.json`. */
  skipWriteConfig?: boolean;
}

export interface SwapDeployResult {
  network: NetworkName;
  chainId: string;
  rollupVersion: string;
  deployerAddress: string;
  contracts: {
    goCoin: string;
    goCoinPremium: string;
    liquidityToken: string;
    amm: string;
    pop: string;
    sponsoredFPC: string;
    salt: string;
  };
  configPath: string | null;
}

/**
 * Maps the app's payment mode to a framework {@link FeePolicy}, or `undefined` to take the
 * framework's per-network default (sponsored on local, fee-juice on testnet). An explicit
 * `--payment` is an override: `sponsoredfpc` forces a SponsoredFPC, and `feejuice` forces the
 * deployer to pay from its own Fee Juice (bridging from L1 if low) — including when forced on
 * local, which is how the e2e exercises the testnet path locally. The L1 funder key / RPC come
 * from the env here (the framework never reads it itself); both are optional in the policy.
 */
function forcePaymentMode(paymentMode?: PaymentMode): FeePolicy {
  if (paymentMode === "sponsoredfpc") {
    return { kind: "sponsored" };
  } else
    return {
      kind: "fee-juice",
      threshold: 100n * ONE_FEE_JUICE,
      fundAmount: 1000n * ONE_FEE_JUICE,
      l1FunderKey: process.env.L1_FUNDER_KEY as `0x${string}` | undefined,
      l1RpcUrl: process.env.L1_RPC_URL,
    };
}

function writeNetworkConfig(
  network: NetworkName,
  nodeUrl: string,
  deploymentInfo: {
    chainId: string;
    rollupVersion: string;
    goCoinAddress: string;
    goCoinPremiumAddress: string;
    ammAddress: string;
    liquidityTokenAddress: string;
    popAddress: string;
    salt: string;
    deployerAddress: string;
  },
  sponsoredFPCAddress: string,
): string {
  const configDir = path.join(import.meta.dirname, "../src/config/networks");
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, `${network}.json`);

  // Preserve the existing `subscriptionFPC` block across redeploys. The FPC is
  // deployed/signed-up out of band (fpc-operator), and `register-fpc-signups`
  // reads the last-used config index from this block to advance to a fresh
  // `config_id` on each run (sign_up now reverts on a duplicate). Rebuilding
  // the config from scratch here used to wipe it, resetting the index to 0
  // every deploy and silently stacking stale-priced slots on the same FPC.
  const existing = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf-8"))
    : {};

  const config = {
    id: network,
    nodeUrl,
    chainId: deploymentInfo.chainId,
    rollupVersion: deploymentInfo.rollupVersion,
    contracts: {
      goCoin: deploymentInfo.goCoinAddress,
      goCoinPremium: deploymentInfo.goCoinPremiumAddress,
      amm: deploymentInfo.ammAddress,
      liquidityToken: deploymentInfo.liquidityTokenAddress,
      pop: deploymentInfo.popAddress,
      sponsoredFPC: sponsoredFPCAddress,
      salt: deploymentInfo.salt,
    },
    deployer: {
      address: deploymentInfo.deployerAddress,
    },
    deployedAt: new Date().toISOString(),
    ...(existing.subscriptionFPC ? { subscriptionFPC: existing.subscriptionFPC } : {}),
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  wrote config    ${configPath}`);
  return configPath;
}

/**
 * Programmatic entry point. Safe to import — does not read argv or exit the process. Reads
 * `SWAP_ADMIN_SECRET`/`L1_FUNDER_KEY`/`L1_RPC_URL` from the env only as fallbacks; the caller
 * may pipe `deployerSecret` instead.
 */
export async function runSwapDeploy(opts: SwapDeployOptions): Promise<SwapDeployResult> {
  const network = opts.network;
  const nodeUrl = NETWORK_URLS[network];
  const password = opts.password;
  const mintTo = opts.mintTo ?? [];
  const { secretKey } = opts.deployerSecret
    ? { secretKey: Fr.fromString(opts.deployerSecret) }
    : loadOrCreateSecret("SWAP_ADMIN_SECRET");
  const sponsoredFPCAddress = (await getSponsoredFPCContract()).address.toString();

  // The contracts that must end up on-chain. Three tokens share the Token class (the framework
  // publishes it once); the AMM takes the three token addresses, PoP takes GoCoin + the password.
  // Written as a literal (validated by `satisfies`) so `ctx.instance(alias)` is typed per-alias.
  const contracts = {
    goCoin: {
      kind: "contract",
      contract: TokenContract,
      deployer: (resolve) => resolve.account("admin"),
      initializerArgs: (resolve) => [resolve.account("admin"), "GoCoin", "GO", 18],
      mode: "publish",
    },
    goCoinPremium: {
      kind: "contract",
      contract: TokenContract,
      deployer: (resolve) => resolve.account("admin"),
      initializerArgs: (resolve) => [resolve.account("admin"), "GoCoinPremium", "GOP", 18],
      mode: "publish",
    },
    liquidityToken: {
      kind: "contract",
      contract: TokenContract,
      deployer: (resolve) => resolve.account("admin"),
      initializerArgs: (resolve) => [resolve.account("admin"), "GoLiquidity", "GOLP", 18],
      mode: "publish",
    },
    amm: {
      kind: "contract",
      contract: AMMContract,
      deployer: (resolve) => resolve.account("admin"),
      initializerArgs: (resolve) => [
        resolve.contract("goCoin"),
        resolve.contract("goCoinPremium"),
        resolve.contract("liquidityToken"),
      ],
      mode: "publish",
    },
    pop: {
      kind: "contract",
      contract: ProofOfPasswordContract,
      deployer: (resolve) => resolve.account("admin"),
      initializerArgs: (resolve) => [resolve.contract("goCoin"), password],
      mode: "publish",
    },
  } satisfies Record<string, ContractStep>;
  type Contracts = typeof contracts;

  // Extra `--mint-to` recipients get the same starting balance on the two spendable tokens, but
  // only when that token is freshly deployed (a reused token already carries balances forward).
  const mintToActions: Record<string, ActionStep<Contracts>> = Object.fromEntries(
    mintTo.flatMap((address, i) => {
      const recipient = AztecAddress.fromStringUnsafe(address);
      return [
        [
          `mintGoCoinTo${i}`,
          {
            kind: "action",
            from: (resolve) => resolve.account("admin"),
            dependsOn: ["goCoin"],
            call: (ctx) =>
              ctx.instance("goCoin").methods.mint_to_private(recipient, INITIAL_TOKEN_BALANCE),
            // The recipient's private balance isn't readable by the deployer, so gate on GoCoin
            // being freshly published this run (a reused token already carries the balance forward).
            done: async (ctx) => !(await ctx.ran("goCoin")),
          } satisfies ActionStep<Contracts>,
        ],
        [
          `mintGoCoinPremiumTo${i}`,
          {
            kind: "action",
            from: (resolve) => resolve.account("admin"),
            dependsOn: ["goCoinPremium"],
            call: (ctx) =>
              ctx
                .instance("goCoinPremium")
                .methods.mint_to_private(recipient, INITIAL_TOKEN_BALANCE),
            done: async (ctx) => !(await ctx.ran("goCoinPremium")),
          } satisfies ActionStep<Contracts>,
        ],
      ];
    }),
  );

  // Bootstrap txs. Each declares the contracts it calls in `dependsOn`, and checks idempotency
  // against the actual on-chain effect where observable (minter flags, LP supply) so a partial run
  // resumes. The mints feed addLiquidity, so they're "done" once the pool they seed is — defer to
  // its gate (re-minting on a crash is harmless; the old deploy-freshness proxy left the pool empty).
  const bootstrapActions: Record<string, ActionStep<Contracts>> = {
    mintGoCoin: {
      kind: "action",
      from: (resolve) => resolve.account("admin"),
      dependsOn: ["goCoin"],
      call: (ctx) =>
        ctx.instance("goCoin").methods.mint_to_private(ctx.account("admin"), INITIAL_TOKEN_BALANCE),
      done: async (ctx) => ctx.done("addLiquidity"),
    },
    mintGoCoinPremium: {
      kind: "action",
      from: (resolve) => resolve.account("admin"),
      dependsOn: ["goCoinPremium"],
      call: (ctx) =>
        ctx
          .instance("goCoinPremium")
          .methods.mint_to_private(ctx.account("admin"), INITIAL_TOKEN_BALANCE),
      done: async (ctx) => ctx.done("addLiquidity"),
    },
    // LiquidityToken needs the AMM as a public minter — read the minter flag back directly.
    setLiquidityMinter: {
      kind: "action",
      from: (resolve) => resolve.account("admin"),
      dependsOn: ["liquidityToken", "amm"],
      call: (ctx) => ctx.instance("liquidityToken").methods.set_minter(ctx.contract("amm"), true),
      done: async (ctx) => {
        const { result } = await ctx
          .instance("liquidityToken")
          .methods.is_minter(ctx.contract("amm"))
          .simulate({ from: ctx.account("admin") });
        return Boolean(result);
      },
    },
    // Seed the pool — needs the minted balances + the AMM as LP minter first. Seeding mints LP, so a
    // non-zero LiquidityToken supply means the pool is already seeded.
    addLiquidity: {
      kind: "action",
      from: (resolve) => resolve.account("admin"),
      dependsOn: ["mintGoCoin", "mintGoCoinPremium", "setLiquidityMinter", "amm"],
      call: (ctx) =>
        ctx
          .instance("amm")
          .methods.add_liquidity(
            INITIAL_TOKEN_BALANCE,
            INITIAL_TOKEN_BALANCE,
            INITIAL_TOKEN_BALANCE,
            INITIAL_TOKEN_BALANCE,
            Fr.random(),
          ),
      done: async (ctx) => {
        const { result } = await ctx
          .instance("liquidityToken")
          .methods.total_supply()
          .simulate({ from: ctx.account("admin") });
        return BigInt(result) > 0n;
      },
    },
    // PoP needs minter rights on GoCoin so it can mint to the password-revealer.
    setPopMinter: {
      kind: "action",
      from: (resolve) => resolve.account("admin"),
      dependsOn: ["goCoin", "pop"],
      call: (ctx) => ctx.instance("goCoin").methods.set_minter(ctx.contract("pop"), true),
      done: async (ctx) => {
        const { result } = await ctx
          .instance("goCoin")
          .methods.is_minter(ctx.contract("pop"))
          .simulate({ from: ctx.account("admin") });
        return Boolean(result);
      },
    },
  };

  let result: SwapDeployResult | undefined;

  await runDeployment({
    network,
    nodeUrl,
    salt: getSalt(),
    stateDir: path.join(import.meta.dirname, "..", ".deploy-state"),
    accounts: { admin: { secret: secretKey } },
    fees: opts.paymentMode ? forcePaymentMode(opts.paymentMode) : undefined,
    // One graph: the contracts (above) plus the bootstrap txs and any --mint-to mints. The wallet
    // auto-creates the add_liquidity authwits at send time.
    steps: { ...contracts, ...bootstrapActions, ...mintToActions },
    output: async (ctx) => {
      const { rollupVersion, l1ChainId } = await ctx.node.getNodeInfo();
      const deploymentInfo = {
        chainId: l1ChainId.toString(),
        rollupVersion: rollupVersion.toString(),
        goCoinAddress: ctx.contract("goCoin").toString(),
        goCoinPremiumAddress: ctx.contract("goCoinPremium").toString(),
        liquidityTokenAddress: ctx.contract("liquidityToken").toString(),
        ammAddress: ctx.contract("amm").toString(),
        popAddress: ctx.contract("pop").toString(),
        salt: getSalt().toString(),
        deployerAddress: ctx.account("admin").toString(),
      };
      const configPath = opts.skipWriteConfig
        ? null
        : writeNetworkConfig(network, nodeUrl, deploymentInfo, sponsoredFPCAddress);
      result = {
        network,
        chainId: deploymentInfo.chainId,
        rollupVersion: deploymentInfo.rollupVersion,
        deployerAddress: deploymentInfo.deployerAddress,
        contracts: {
          goCoin: deploymentInfo.goCoinAddress,
          goCoinPremium: deploymentInfo.goCoinPremiumAddress,
          liquidityToken: deploymentInfo.liquidityTokenAddress,
          amm: deploymentInfo.ammAddress,
          pop: deploymentInfo.popAddress,
          sponsoredFPC: sponsoredFPCAddress,
          salt: deploymentInfo.salt,
        },
        configPath,
      };
    },
  });

  if (!result) throw new Error("Deployment finished without producing a result.");
  return result;
}

async function cli(): Promise<void> {
  const network = parseNetwork();
  const paymentMode = parsePaymentMode(network);
  const mintTo = parseAddressList("--mint-to", "MINT_TO");
  const password = process.env.PASSWORD ?? "potato";

  // Establish the swap admin here (initializerless — no account-deploy step) so we can echo its
  // identity for the orchestrator (`scripts/setup-network.sh`) to pipe into the later steps.
  const { secretKey, generated } = loadOrCreateSecret("SWAP_ADMIN_SECRET");
  const result = await runSwapDeploy({
    network,
    paymentMode,
    password,
    mintTo,
    deployerSecret: secretKey.toString(),
  });

  if (generated) console.log(`export SWAP_ADMIN_SECRET=${secretKey.toString()}`);
  console.log(`export SWAP_ADMIN_ADDRESS=${result.deployerAddress}`);
}

// Only run the CLI when invoked directly (not when imported).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  cli()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
