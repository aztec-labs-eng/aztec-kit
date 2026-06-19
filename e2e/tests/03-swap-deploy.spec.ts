import { test, expect } from "../fixtures/test-base.ts";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readState,
  writeState,
  hasState,
  STATE_FILES,
  type GlobalState,
  type SwapDeploymentState,
} from "../fixtures/state.ts";
import { getPublicFeeJuiceBalance } from "../fixtures/fee-juice-balance.ts";

/**
 * Spec 03 — deploy the swap contracts as swap-admin, paying with native FJ.
 *
 * One subprocess step: `deploy.ts --payment feejuice`. The swap admin is an
 * initializerless account (no separate account-deploy step), so it's usable
 * straight away. Spec 02 bridged + claimed FJ to its deterministic address;
 * the deploy framework's fee-juice policy pays for the contract deploys from
 * that balance (this is the testnet path, exercised here on the local network).
 *
 * Running the script as a subprocess keeps Playwright's bundled Babel
 * transformer away from contract artifacts that use `public declare` class
 * fields (which require a specific plugin order); plain Node with
 * `--experimental-transform-types` handles them fine.
 *
 * Output is written to `apps/swap/src/config/networks/local.json`; we read
 * that back and mirror the relevant bits into the `swapDeployment` state file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SWAP_DIR = resolve(REPO_ROOT, "apps/swap");
const SWAP_LOCAL_JSON = resolve(SWAP_DIR, "src/config/networks/local.json");

function runSwapScript(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(
      "node",
      ["--experimental-transform-types", `scripts/${name}`, "--network", "local", ...args],
      { cwd: SWAP_DIR, env, stdio: "inherit" },
    );
    child.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`${name} exited with code ${code}`));
    });
    child.on("error", rej);
  });
}

test.describe.serial("swap deploy", () => {
  test.slow();

  test("deploys swap contracts as swap-admin paying with fee juice", async () => {
    test.skip(
      hasState(STATE_FILES.swapDeployment),
      `checkpoint exists at ${STATE_FILES.swapDeployment}`,
    );
    const global = await readState<GlobalState>(STATE_FILES.global);

    // Sanity: the account that spec 02 funded should still have FJ.
    const preBalance = await getPublicFeeJuiceBalance(global.nodeUrl, global.swapAdmin.address);
    console.log(`[e2e] swap-admin FJ before deploy = ${preBalance}`);
    expect(preBalance).toBeGreaterThan(0n);

    // The PoP contract bakes the password into its storage at deploy time,
    // so capture whatever we used here and persist it alongside the rest of
    // the deployment state. Downstream specs read it from there rather than
    // hardcoding their own copy.
    const password = process.env.PASSWORD ?? "potato";

    const scriptEnv: NodeJS.ProcessEnv = {
      ...process.env,
      SWAP_ADMIN_SECRET: global.swapAdmin.secret,
      // Forward the salt global-setup derived the admin with, so deploy reconstructs the same
      // address spec 02 funded (instead of both relying on an unset ambient SALT).
      SALT: global.swapAdmin.salt,
      PASSWORD: password,
    };

    // The swap admin is an initializerless account — no separate account-deploy step. Spec 02
    // bridged + claimed FJ to it; deploy.ts pays for the contract deploys from that FJ balance
    // via the framework's fee-juice policy (this is the testnet path, exercised here on local).
    await runSwapScript("deploy.ts", ["--payment", "feejuice"], scriptEnv);

    const raw = await readFile(SWAP_LOCAL_JSON, "utf-8");
    const deployed = JSON.parse(raw) as {
      chainId: string;
      rollupVersion: string;
      contracts: {
        goCoin: string;
        goCoinPremium: string;
        amm: string;
        liquidityToken: string;
        pop: string;
        salt: string;
      };
      deployer: { address: string };
    };

    expect(deployed.deployer.address.toLowerCase()).toBe(global.swapAdmin.address.toLowerCase());

    const state: SwapDeploymentState = {
      goCoin: deployed.contracts.goCoin,
      goCoinPremium: deployed.contracts.goCoinPremium,
      liquidityToken: deployed.contracts.liquidityToken,
      amm: deployed.contracts.amm,
      pop: deployed.contracts.pop,
      contractSalt: deployed.contracts.salt,
      deployerAddress: deployed.deployer.address,
      rollupVersion: deployed.rollupVersion,
      password,
    };
    await writeState(STATE_FILES.swapDeployment, state);
    console.log(`[e2e] wrote ${STATE_FILES.swapDeployment}`);
  });
});
