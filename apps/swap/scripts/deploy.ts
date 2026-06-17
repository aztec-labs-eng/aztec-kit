import fs from "fs";
import path from "path";
import { fileURLToPath } from "node:url";

import { TokenContract, TokenContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/Token";
import { AMMContract, AMMContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/AMM";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/foundation/curves/bn254";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

import {
  ProofOfPasswordContract,
  ProofOfPasswordContractArtifact,
} from "@aztec-kit/contracts-aztec/artifacts/ProofOfPassword";
import {
  BatchCall,
  NO_WAIT,
  type ContractFunctionInteraction,
  type DeployOptions,
  type WaitOpts,
} from "@aztec/aztec.js/contracts";
import { waitForTx, type AztecNode } from "@aztec/aztec.js/node";

import {
  parseNetwork,
  parseAddressList,
  parsePaymentMode,
  NETWORK_URLS,
  setupWallet,
  loadOrCreateSecret,
  getAdmin,
  getSalt,
  type NetworkName,
  type PaymentMode,
  type PaymentMethod,
} from "@aztec-kit/common/testing";
import { TxStatus } from "@aztec/stdlib/tx";

const INITIAL_TOKEN_BALANCE = 1_000_000_000n;

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

async function deployContracts(
  wallet: EmbeddedWallet,
  node: AztecNode,
  deployer: AztecAddress,
  password: string,
  mintToAddresses: string[],
  paymentMethod?: PaymentMethod,
) {
  const salt = getSalt();

  // ── Build every deployment method + derive its deterministic address ──
  //
  // The AMM depends on token addresses, so tokens must resolve first. PoP
  // depends on GoCoin. Everything uses the same salt so re-runs with the
  // same admin + SALT produce the same addresses and can be skipped.
  const goCoinDeploy = TokenContract.deploy(wallet, deployer, "GoCoin", "GO", 18, {
    deployer,
    salt,
  });
  const goCoinPremiumDeploy = TokenContract.deploy(wallet, deployer, "GoCoinPremium", "GOP", 18, {
    deployer,
    salt,
  });
  const liquidityTokenDeploy = TokenContract.deploy(wallet, deployer, "GoLiquidity", "GOLP", 18, {
    deployer,
    salt,
  });

  const goCoinInstance = await goCoinDeploy.getInstance();
  const goCoinPremiumInstance = await goCoinPremiumDeploy.getInstance();
  const liquidityTokenInstance = await liquidityTokenDeploy.getInstance();

  const ammDeploy = AMMContract.deploy(
    wallet,
    goCoinInstance.address,
    goCoinPremiumInstance.address,
    liquidityTokenInstance.address,
    { deployer, salt },
  );
  const ammInstance = await ammDeploy.getInstance();

  const popDeploy = ProofOfPasswordContract.deploy(wallet, goCoinInstance.address, password, {
    deployer,
    salt,
  });
  const popInstance = await popDeploy.getInstance();

  await Promise.all([
    wallet.registerContract(goCoinInstance, TokenContractArtifact),
    wallet.registerContract(goCoinPremiumInstance, TokenContractArtifact),
    wallet.registerContract(liquidityTokenInstance, TokenContractArtifact),
    wallet.registerContract(ammInstance, AMMContractArtifact),
    wallet.registerContract(popInstance, ProofOfPasswordContractArtifact),
  ]);

  // ── Gate deploys on what's already on-chain ─────────────────────────
  //
  // registerContract is idempotent + fast, so we always register. Deploy is
  // only sent when node.getContract returns null for that address. Each
  // contract is independent here; addresses are deterministic functions of
  // (salt, deployer, class id, ctor args), so a class change on any leaf
  // (e.g. Token's noir source) automatically cascades — every dependent
  // contract's address shifts too and gets redeployed by this same gate.
  const [goCoinExists, goCoinPremiumExists, liquidityTokenExists, ammExists, popExists] =
    await Promise.all([
      node.getContract(goCoinInstance.address),
      node.getContract(goCoinPremiumInstance.address),
      node.getContract(liquidityTokenInstance.address),
      node.getContract(ammInstance.address),
      node.getContract(popInstance.address),
    ]);

  const tokens = [
    { label: "GoCoin", contract: goCoinInstance, exists: !!goCoinExists },
    { label: "GoCoinPremium", contract: goCoinPremiumInstance, exists: !!goCoinPremiumExists },
    { label: "LiquidityToken", contract: liquidityTokenInstance, exists: !!liquidityTokenExists },
  ];

  console.log("Deploy plan:");
  for (const t of tokens) {
    console.log(`  ${t.label}: ${t.exists ? "reuse" : "deploy"} (${t.contract.address})`);
  }
  console.log(`  AMM:           ${ammExists ? "reuse" : "deploy"} (${ammInstance.address})`);
  console.log(`  PoP:           ${popExists ? "reuse" : "deploy"} (${popInstance.address})`);

  const { isContractClassPubliclyRegistered: isTokenPubliclyRegistered } =
    await wallet.getContractClassMetadata(goCoinInstance.currentContractClassId);

  const currentMinFees = await node.getCurrentMinFees();
  const baseOpts: DeployOptions<WaitOpts> = {
    from: deployer,
    fee: { paymentMethod, gasSettings: { maxFeesPerGas: currentMinFees.mul(10) } },
    wait: { timeout: 120 },
  };

  // In a fresh chain (local network) we deploy the first token so class registration
  // is done before the other deployments happen
  if (!isTokenPubliclyRegistered) {
    await goCoinDeploy.send(baseOpts);
  }

  // Fire every missing deploy in parallel with NO_WAIT so simulate+prove+
  // submit pipelines, then await all tx hashes at the end. The deploys
  // don't depend on each other being *mined* — AMM/PoP need the token
  // *addresses*, which are already known deterministically.
  //
  // Each .send must be called with `{ wait: NO_WAIT }` inline so TypeScript
  // picks the TxSendResultImmediate overload (which exposes `txHash`). A
  // wrapped helper would widen the option type and fall back to the default
  // `DeployResultMined` overload.
  const pending = [
    goCoinExists || !isTokenPubliclyRegistered
      ? null
      : goCoinDeploy.send({ ...baseOpts, wait: NO_WAIT }),
    goCoinPremiumExists ? null : goCoinPremiumDeploy.send({ ...baseOpts, wait: NO_WAIT }),
    liquidityTokenExists ? null : liquidityTokenDeploy.send({ ...baseOpts, wait: NO_WAIT }),
    ammExists ? null : ammDeploy.send({ ...baseOpts, wait: NO_WAIT }),
    popExists ? null : popDeploy.send({ ...baseOpts, wait: NO_WAIT }),
  ].filter((p): p is Exclude<typeof p, null> => p !== null);
  const sent = await Promise.all(pending);
  await Promise.all(
    sent.map((r) => waitForTx(node, r.txHash, { waitForStatus: TxStatus.PROPOSED, timeout: 120 })),
  );

  const goCoin = TokenContract.at(goCoinInstance.address, wallet);
  const goCoinPremium = TokenContract.at(goCoinPremiumInstance.address, wallet);
  const liquidityToken = TokenContract.at(liquidityTokenInstance.address, wallet);
  const amm = AMMContract.at(ammInstance.address, wallet);
  const pop = ProofOfPasswordContract.at(popInstance.address, wallet);

  // ── Post-deploy bootstrapping ───────────────────────────────────────
  //
  // Each post-deploy action is gated on the precise on-chain state it sets,
  // not on "did the AMM redeploy". This matters because partial redeploys
  // are common: change AMM's noir source and the tokens still exist with
  // their state (balances, minter maps) intact. Re-running the old monolithic
  // `if (!ammExists)` block would have:
  //   - re-minted INITIAL_TOKEN_BALANCE on top of the existing deployer
  //     balance (token state survives the AMM redeploy);
  //   - re-set the liquidity-token minter twice (the original ran the same
  //     call in two batches).
  //
  // The per-action gates below send only the writes that are actually needed.

  // 1. Initial token mints. Per-token gate: if a token is fresh, the deployer
  //    + every `--mint-to` recipient gets its starting balance on THAT token.
  //    A reused token already carries those balances forward.
  const seedMints: ContractFunctionInteraction[] = [];
  const tokensToSeed: Array<{ label: string; contract: TokenContract; exists: boolean }> = [
    { label: "GoCoin", contract: goCoin, exists: !!goCoinExists },
    { label: "GoCoinPremium", contract: goCoinPremium, exists: !!goCoinPremiumExists },
  ];
  for (const { label, contract, exists } of tokensToSeed) {
    if (exists) continue;
    seedMints.push(contract.methods.mint_to_private(deployer, INITIAL_TOKEN_BALANCE));
    for (const addr of mintToAddresses) {
      console.log(`Will mint ${INITIAL_TOKEN_BALANCE} ${label} to ${addr}`);
      seedMints.push(
        contract.methods.mint_to_private(AztecAddress.fromString(addr), INITIAL_TOKEN_BALANCE),
      );
    }
  }

  // 2. LiquidityToken needs the AMM as a public minter. The minter map is
  //    keyed on AMM address, so a new AMM needs a new entry even when the
  //    LiquidityToken is reused. (And if LiquidityToken is fresh, its map
  //    starts empty regardless of AMM.) The original code ran this twice;
  //    here it runs at most once, in the same batch as the seed mints.
  const liquidityMinterCalls: ContractFunctionInteraction[] = [];
  if (!liquidityTokenExists || !ammExists) {
    liquidityMinterCalls.push(liquidityToken.methods.set_minter(amm.address, true));
  }

  if (seedMints.length > 0 || liquidityMinterCalls.length > 0) {
    await new BatchCall(wallet, [...liquidityMinterCalls, ...seedMints]).send(baseOpts);
  }

  // 3. Seed the AMM pool. Pool state lives in AMM storage, so an AMM
  //    redeploy starts empty; a reused AMM already has the liquidity.
  //    Re-running this would double the pool's reserves
  if (!ammExists) {
    const nonceForAuthwits = Fr.random();
    const [token0Authwit, token1Authwit] = await Promise.all(
      [goCoin, goCoinPremium].map(async (token) =>
        wallet.createAuthWit(deployer, {
          caller: amm.address,
          call: await token.methods
            .transfer_to_public_and_prepare_private_balance_increase(
              deployer,
              amm.address,
              INITIAL_TOKEN_BALANCE,
              nonceForAuthwits,
            )
            .getFunctionCall(),
        }),
      ),
    );

    await new BatchCall(wallet, [
      amm.methods
        .add_liquidity(
          INITIAL_TOKEN_BALANCE,
          INITIAL_TOKEN_BALANCE,
          INITIAL_TOKEN_BALANCE,
          INITIAL_TOKEN_BALANCE,
          nonceForAuthwits,
        )
        .with({ authWitnesses: [token0Authwit, token1Authwit] }),
    ]).send(baseOpts);
  }

  // 4. PoP needs minter rights on GoCoin so it can mint to the password-revealer.
  //    Gate on PoP being fresh: a redeploy of just PoP (GoCoin unchanged) still
  //    needs this because the new PoP address isn't in GoCoin's minter map.
  if (!popExists) {
    await goCoin.methods.set_minter(pop.address, true).send(baseOpts);
  }

  return {
    goCoinAddress: goCoin.address.toString(),
    goCoinPremiumAddress: goCoinPremium.address.toString(),
    liquidityTokenAddress: liquidityToken.address.toString(),
    ammAddress: amm.address.toString(),
    popAddress: pop.address.toString(),
    salt: salt.toString(),
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

  console.log(`
      \n\n\n
      Contracts deployed successfully to ${network}!
      Network config saved to: ${configPath}

      Deployed contracts:
      - GoCoin: ${deploymentInfo.goCoinAddress}
      - GoCoinPremium: ${deploymentInfo.goCoinPremiumAddress}
      - AMM: ${deploymentInfo.ammAddress}
      - Liquidity Token: ${deploymentInfo.liquidityTokenAddress}
      - Proof of password: ${deploymentInfo.popAddress}

      Deployer: ${deploymentInfo.deployerAddress}
      \n\n\n
    `);

  return configPath;
}

/**
 * Programmatic entry point. Safe to import — does not read argv, exit the
 * process, or look at env vars other than `SECRET` (as a fallback for
 * `deployerSecret`).
 */
export async function runSwapDeploy(opts: SwapDeployOptions): Promise<SwapDeployResult> {
  const nodeUrl = NETWORK_URLS[opts.network];
  const { node, wallet, sponsoredFPC, paymentMethod } = await setupWallet(
    nodeUrl,
    opts.network,
    opts.paymentMode,
  );

  const { rollupVersion, l1ChainId: chainId } = await node.getNodeInfo();

  const { secretKey } = opts.deployerSecret
    ? { secretKey: Fr.fromString(opts.deployerSecret) }
    : loadOrCreateSecret("SWAP_ADMIN_SECRET");
  const deployer = await getAdmin(
    wallet,
    secretKey,
    `Run \`yarn swap deploy-admin:${opts.network}\` first.`,
  );

  const contractDeploymentInfo = await deployContracts(
    wallet,
    node,
    deployer,
    opts.password,
    opts.mintTo ?? [],
    paymentMethod,
  );

  const deploymentInfo = {
    ...contractDeploymentInfo,
    chainId: chainId.toString(),
    rollupVersion: rollupVersion.toString(),
    deployerAddress: deployer.toString(),
  };

  const configPath = opts.skipWriteConfig
    ? null
    : writeNetworkConfig(opts.network, nodeUrl, deploymentInfo, sponsoredFPC.address.toString());

  return {
    network: opts.network,
    chainId: deploymentInfo.chainId,
    rollupVersion: deploymentInfo.rollupVersion,
    deployerAddress: deploymentInfo.deployerAddress,
    contracts: {
      goCoin: deploymentInfo.goCoinAddress,
      goCoinPremium: deploymentInfo.goCoinPremiumAddress,
      liquidityToken: deploymentInfo.liquidityTokenAddress,
      amm: deploymentInfo.ammAddress,
      pop: deploymentInfo.popAddress,
      sponsoredFPC: sponsoredFPC.address.toString(),
      salt: deploymentInfo.salt,
    },
    configPath,
  };
}

async function cli(): Promise<void> {
  const network = parseNetwork();
  const paymentMode = parsePaymentMode(network);
  const mintTo = parseAddressList("--mint-to", "MINT_TO");
  const password = process.env.PASSWORD ?? "potato";

  await runSwapDeploy({ network, paymentMode, password, mintTo });
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
