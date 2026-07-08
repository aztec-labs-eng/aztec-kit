import { type Page } from "@playwright/test";
import { test, expect } from "../fixtures/test-base.ts";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FunctionSelector } from "@aztec/stdlib/abi";
import { ProofOfPasswordContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/ProofOfPassword";
import { AMMContractArtifact } from "@aztec-kit/contracts-aztec/artifacts/AMM";
import { TokenContractArtifact } from "@aztec/noir-contracts.js/Token";
import {
  readState,
  writeState,
  hasState,
  STATE_FILES,
  type GlobalState,
  type FpcState,
  type SwapDeploymentState,
} from "../fixtures/state.ts";

/**
 * Spec 04 — fpc-admin signs up three sponsored apps.
 *
 * Flow:
 *   1. Mint GoCoin + GoCoinPremium to fpc-admin (so calibration can
 *      simulate swap / mint calls). Uses swap-admin as the signer via
 *      `apps/swap/scripts/mint.ts` in a subprocess.
 *   2. Restore the spec-01 backup into a fresh fpc-dashboard context so we
 *      have the same fpc-admin + FPC contract.
 *   3. In the "Sign Up App" tab, run the full 4-step wizard three times:
 *      - ProofOfPassword::check_password_and_mint — mints GoCoin
 *        for a user that presents the password.
 *      - AMM::swap_tokens_for_exact_tokens_from — swaps GoCoin for
 *        GoCoinPremium on behalf of a user.
 *      - Token(GoCoin)::transfer_in_private_with_offchain_delivery — the
 *        swap app's offchain send (exercised by spec 07). Without this
 *        signup the app's send path throws "No subscription config found".
 *   4. Compute function selectors from the artifacts and write the
 *      `subscriptionFPC` section into swap's `local.json`, plus update
 *      `e2e/.state/fpc.json` with the signed-up apps.
 *
 * Both the fpc-admin (funded by spec 01 bridge) and the fpc contract
 * (funded by spec 01 Deploy FPC step) still hold fee juice from earlier,
 * so this spec does not touch the bridge.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const SWAP_DIR = resolve(REPO_ROOT, "apps/swap");
const SWAP_LOCAL_JSON = resolve(SWAP_DIR, "src/config/networks/local.json");
const ARTIFACTS_DIR = resolve(REPO_ROOT, "packages/contracts/aztec/noir/target");
const POP_ARTIFACT_PATH = resolve(ARTIFACTS_DIR, "proof_of_password-ProofOfPassword.json");
const AMM_ARTIFACT_PATH = resolve(ARTIFACTS_DIR, "amm_contract-AMM.json");
const TOKEN_ARTIFACT_PATH = resolve(
  REPO_ROOT,
  "node_modules/@aztec/noir-contracts.js/artifacts/token_contract-Token.json",
);

function runMint(env: NodeJS.ProcessEnv, toAddress: string): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn(
      "node",
      [
        "--experimental-transform-types",
        "scripts/mint.ts",
        "--network",
        "local",
        "--to",
        toAddress,
      ],
      { cwd: SWAP_DIR, env, stdio: "inherit" },
    );
    child.on("exit", (code) => {
      if (code === 0) res();
      else rej(new Error(`mint.ts exited with code ${code}`));
    });
    child.on("error", rej);
  });
}

async function restoreBackup(page: Page) {
  // Seed network selection before the app boots so the SetupWizard doesn't
  // bounce us to testnet.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("aztec_kit_network", "local");
    } catch {
      /* ignore */
    }
  });

  await page.goto("/");

  // The SetupWizard is always the landing view until fpc-admin is restored.
  // It exposes the "Restore from Backup" affordance in import-only mode.
  const wizard = page.getByTestId("setup-wizard");
  await wizard.waitFor({ timeout: 60_000 });

  // BackupRestore's confirm-click handler early-returns when `wallet` is
  // still null. Wait for the wizard to leave step 0 ("Creating embedded
  // wallet...") before proceeding — that's the signal the wallet context
  // is ready.
  await expect(wizard).not.toHaveAttribute("data-active-step", "0", { timeout: 90_000 });

  // The import-only button triggers the hidden input via a ref click,
  // which would pop the OS file dialog — Playwright can't drive that.
  // Instead we wait for the input to attach and set files directly.
  await page.getByTestId("backup-import-trigger").waitFor({ timeout: 30_000 });
  await page.getByTestId("backup-import-input").setInputFiles(STATE_FILES.fpcBackup);

  // Confirmation dialog appears — click "Restore". The confirm button is
  // inside the dialog's Paper, so waiting for the button to attach implies
  // the dialog rendered.
  const confirmBtn = page.getByTestId("backup-import-confirm-button");
  await confirmBtn.waitFor({ state: "visible", timeout: 30_000 });
  await confirmBtn.click();

  // applyBackup() triggers window.location.reload(). Wait for the dashboard
  // to render post-reload — that's the signal that fpc-admin was restored.
  await page.getByTestId("dashboard").waitFor({ timeout: 120_000 });
}

interface SignUpArgs {
  artifactPath: string;
  contractAddress: string;
  contractAlias: string;
  functionName: string;
  /** function args in declaration order, already stringified as the form expects */
  args: Record<string, string>;
  /** Extra contract registrations required by the sponsored function. */
  extras: { artifactPath: string; address: string; alias: string }[];
  /**
   * Senders to register with the admin PXE so note-tag discovery works
   * during calibration (e.g. the account that minted private notes to
   * fpc-admin). Chips persist in localStorage so you only need to list
   * each sender once across the session.
   */
  senders?: { address: string; alias: string }[];
  configIndex: number;
}

async function signUpOneApp(page: Page, args: SignUpArgs) {
  const wizard = page.getByTestId("app-signup");

  // Ensure we're at step 0 (artifact + address). Previous sign-up resets
  // to step 0 after 3s; if we're still on step 3, wait for the reset.
  await expect(wizard).toHaveAttribute("data-active-step", "0", { timeout: 30_000 });

  // ── Step 0: upload artifact, enter address, register ────────────────
  await page.getByTestId("app-signup-artifact").setInputFiles(args.artifactPath);
  await page.getByTestId("app-signup-contract-alias").fill(args.contractAlias);
  await page.getByTestId("app-signup-contract-address").fill(args.contractAddress);
  await page.getByTestId("app-signup-register").click();

  // Race: step-1 transition (success) or register-error alert (failure).
  //
  // The register handler calls `setContractInstance()` and `setActiveStep(1)`
  // in the same microtask, so the success alert renders inside step 0 *as*
  // step 0 collapses — in CI the alert is often never "visible" to Playwright,
  // it just flashes through a hidden mount. Watching `data-active-step="1"`
  // instead is equivalent and race-free. Error alert is in step 0 too, but
  // when register fails step never advances, so the error stays visible.
  const registerError = page.getByTestId("app-signup-register-error");
  await Promise.race([
    expect(wizard)
      .toHaveAttribute("data-active-step", "1", { timeout: 180_000 })
      .then(() => {}),
    registerError.waitFor({ state: "visible", timeout: 180_000 }).then(async () => {
      throw new Error(`register failed: ${await registerError.textContent()}`);
    }),
  ]);

  // ── Step 1: pick the function ──────────────────────────────────────
  await page.getByTestId("app-signup-function-select-display").click();
  await page.getByTestId(`app-signup-function-select-option-${args.functionName}`).click();

  // FunctionSelector's handler auto-advances to step 2.
  await expect(wizard).toHaveAttribute("data-active-step", "2", { timeout: 10_000 });

  // ── Step 2: register extras, register senders, fill args, calibrate ─
  for (const extra of args.extras) {
    await page.getByTestId("app-signup-extra-artifact").setInputFiles(extra.artifactPath);
    await page.getByTestId("app-signup-extra-address").fill(extra.address);
    await page.getByTestId("app-signup-extra-alias").fill(extra.alias);
    await page.getByTestId("app-signup-extra-register").click();
    // The extra-register handler clears the form and adds a chip. Wait
    // for the chip keyed by alias to confirm the registration landed.
    await expect(page.getByTestId(`app-signup-extra-chip-${extra.alias}`)).toBeVisible({
      timeout: 60_000,
    });
  }

  // Register senders (idempotent — if the chip already exists from a
  // previous sign-up this round, skip the registration tx).
  for (const sender of args.senders ?? []) {
    const chip = page.getByTestId(`app-signup-sender-chip-${sender.alias}`);
    if (!(await chip.isVisible().catch(() => false))) {
      await page.getByTestId("app-signup-sender-address").fill(sender.address);
      await page.getByTestId("app-signup-sender-alias").fill(sender.alias);
      await page.getByTestId("app-signup-sender-add").click();
      await expect(chip).toBeVisible({ timeout: 30_000 });
    }
  }

  // Fill each arg input by parameter name.
  for (const [paramName, value] of Object.entries(args.args)) {
    await page.getByTestId(`app-signup-arg-${paramName}`).fill(value);
  }

  // Click calibrate. `handleCalibrate` auto-advances the wizard to step 3
  // on success, so we wait for the step transition — NOT for an inner
  // element in step 2, which unmounts. Race against the calibration error
  // alert so a failure surfaces immediately.
  const calibrationError = page.getByTestId("app-signup-calibration-error");
  await page.getByTestId("app-signup-calibrate").click();

  await Promise.race([
    expect(wizard)
      .toHaveAttribute("data-active-step", "3", { timeout: 240_000 })
      .then(() => {}),
    calibrationError.waitFor({ state: "visible", timeout: 240_000 }).then(async () => {
      throw new Error(`calibration failed: ${await calibrationError.textContent()}`);
    }),
  ]);

  // ── Step 3: pick fee source + multiplier, set configIndex, sign up ──
  // The default P75 source pulls from clustec which isn't available on
  // local-network — switch to "Current Min Fee" which queries the node
  // directly. Then crank the multiplier to 10x so calibration has plenty
  // of headroom and we don't hit OutOfGas during real sign-ups.
  await page.getByTestId("app-signup-fee-source-current").click();
  await expect(page.getByTestId("app-signup-fee-source")).toHaveAttribute("data-value", "current", {
    timeout: 5_000,
  });

  // MUI Slider renders a real <input type="range"> inside each thumb.
  // Set its value via a native `input` event — MUI listens for that and
  // forwards to onChange. `.fill()` on a range input doesn't trigger the
  // React onChange path, so we set `.value` and dispatch manually.
  const multiplier = page.getByTestId("app-signup-fee-multiplier");
  await multiplier.locator('input[type="range"]').evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, "10");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(multiplier).toHaveAttribute("data-value", "10", { timeout: 5_000 });

  await page.getByTestId("app-signup-config-index").fill(String(args.configIndex));

  // Max fee is computed from the resolved fee-per-gas × multiplier. Wait
  // for it to populate before submitting.
  await expect(page.getByTestId("app-signup-max-fee")).not.toHaveValue("", {
    timeout: 60_000,
  });

  const submitError = page.getByTestId("app-signup-submit-error");
  await page.getByTestId("app-signup-submit").click();

  const success = page.getByTestId("app-signup-success");
  await Promise.race([
    success.waitFor({ state: "visible", timeout: 300_000 }),
    submitError.waitFor({ state: "visible", timeout: 300_000 }).then(async () => {
      throw new Error(`sign-up failed: ${await submitError.textContent()}`);
    }),
  ]);
}

test.describe.serial("fpc signs up sponsored apps", () => {
  // Three signups × (calibrate ≤ 240s for standalone sim + submit ≤ 300s for
  // the real sign_up tx). `test.slow()`'s ×3 (15 min) cuts it too close on
  // CI when proving is slow. Bump to 35 min for headroom.
  test.setTimeout(35 * 60_000);

  // Mint BEFORE the browser starts. If we ran this inside the test body
  // the `page` fixture would instantiate first, popping an empty browser
  // window while the mint subprocess churns. `beforeAll` doesn't take the
  // page fixture so nothing is launched yet.
  test.beforeAll(async () => {
    if (hasState(STATE_FILES.fpcSignedUp)) {
      console.log(`[e2e] ${STATE_FILES.fpcSignedUp} exists — skipping mint`);
      return;
    }
    const global = await readState<GlobalState>(STATE_FILES.global);
    const fpc = await readState<FpcState>(STATE_FILES.fpc);
    console.log(`[e2e] minting GoCoin + GoCoinPremium to ${fpc.fpcAdminAddress}`);
    await runMint(
      {
        ...process.env,
        SWAP_ADMIN_SECRET: global.swapAdmin.secret,
      },
      fpc.fpcAdminAddress,
    );
  });

  test("signs up PoP + AMM + GoCoin offchain transfer via the fpc-dashboard UI", async ({
    page,
  }) => {
    test.skip(hasState(STATE_FILES.fpcSignedUp), `checkpoint exists at ${STATE_FILES.fpcSignedUp}`);
    const fpc = await readState<FpcState>(STATE_FILES.fpc);
    const swap = await readState<SwapDeploymentState>(STATE_FILES.swapDeployment);

    // ── 1. Restore fpc-admin backup into a fresh dashboard context ───
    await restoreBackup(page);

    // Switch to the Sign Up App tab (it's the default but be explicit).
    await page.getByTestId("tab-sign-up").click();
    await page.getByTestId("app-signup").waitFor({ timeout: 10_000 });

    // ── 2a. Sign up ProofOfPassword::check_password_and_mint ─────────
    // PoP mints fresh private tokens for the recipient, so calibration
    // only needs GoCoin registered — no prior-note discovery needed.
    console.log("[e2e] signing up PoP::check_password_and_mint");
    await signUpOneApp(page, {
      artifactPath: POP_ARTIFACT_PATH,
      contractAddress: swap.pop,
      contractAlias: "ProofOfPassword",
      functionName: "check_password_and_mint",
      args: {
        password: swap.password,
        to: fpc.fpcAdminAddress,
      },
      extras: [
        {
          artifactPath: TOKEN_ARTIFACT_PATH,
          address: swap.goCoin,
          alias: "GoCoin",
        },
      ],
      configIndex: 0,
    });

    // ── 2b. Sign up AMM::swap_tokens_for_exact_tokens_from ───────────
    console.log("[e2e] signing up AMM::swap_tokens_for_exact_tokens_from");
    await signUpOneApp(page, {
      artifactPath: AMM_ARTIFACT_PATH,
      contractAddress: swap.amm,
      contractAlias: "AMM",
      functionName: "swap_tokens_for_exact_tokens_from",
      args: {
        from: fpc.fpcAdminAddress,
        token_in: swap.goCoin,
        token_out: swap.goCoinPremium,
        amount_out: "100",
        amount_in_max: "1000000",
        authwit_nonce: "1",
      },
      extras: [
        {
          artifactPath: TOKEN_ARTIFACT_PATH,
          address: swap.goCoinPremium,
          alias: "GoCoinPremium",
        },
      ],
      senders: [{ address: swap.deployerAddress, alias: "swap-admin" }],
      configIndex: 0,
    });

    // ── 2c. Sign up GoCoin::transfer_in_private_with_offchain_delivery ─
    // Sponsors the swap app's offchain send (spec 07). Mirrors the entry in
    // apps/swap/scripts/register-fpc-signups.ts: calibration runs a 10-token
    // self-transfer (from == to == fpc-admin, authwit_nonce 0 — self-calls
    // need no authwit). fpc-admin's GoCoin was minted by swap-admin in
    // beforeAll; the swap-admin sender chip from 2b (persisted in
    // localStorage) lets note discovery find those notes. GoCoin was already
    // registered as an extra in 2a — re-registering it as the main contract
    // is an idempotent PXE call.
    console.log("[e2e] signing up GoCoin::transfer_in_private_with_offchain_delivery");
    await signUpOneApp(page, {
      artifactPath: TOKEN_ARTIFACT_PATH,
      contractAddress: swap.goCoin,
      contractAlias: "GoCoin",
      functionName: "transfer_in_private_with_offchain_delivery",
      args: {
        from: fpc.fpcAdminAddress,
        to: fpc.fpcAdminAddress,
        amount: "10",
        authwit_nonce: "0",
      },
      extras: [],
      senders: [{ address: swap.deployerAddress, alias: "swap-admin" }],
      configIndex: 0,
    });

    // ── 3. Sanity: the list tab shows 3 apps ─────────────────────────
    await page.getByTestId("tab-registered-apps").click();
    await expect(page.getByTestId("app-list")).toHaveAttribute("data-count", "3", {
      timeout: 30_000,
    });

    // ── 4. Compute selectors and patch swap local.json ───────────────
    // Use the codegen artifact objects (already normalised) rather than
    // parsing raw Noir JSON whose shape nests params under
    // `functions[i].abi.parameters`.
    const popFn = ProofOfPasswordContractArtifact.functions.find(
      (f) => f.name === "check_password_and_mint",
    );
    const ammFn = AMMContractArtifact.functions.find(
      (f) => f.name === "swap_tokens_for_exact_tokens_from",
    );
    const tokenFn = TokenContractArtifact.functions.find(
      (f) => f.name === "transfer_in_private_with_offchain_delivery",
    );
    if (!popFn || !ammFn || !tokenFn) throw new Error("Expected functions missing from artifact");
    const popSelector = await FunctionSelector.fromNameAndParameters(popFn.name, popFn.parameters);
    const ammSelector = await FunctionSelector.fromNameAndParameters(ammFn.name, ammFn.parameters);
    const tokenSelector = await FunctionSelector.fromNameAndParameters(
      tokenFn.name,
      tokenFn.parameters,
    );

    // Pull the sponsored fn's gas limits (no FPC overhead) from the
    // app-list row's data-* attrs. Swap's helpers add the subscribe/sponsor
    // FPC overhead on top at call time; committing the plain gas here keeps
    // the slot's `max_fee` consistent with what runtime will send.
    const readGasInfo = async (appAddress: string, selector: string) => {
      const row = page.getByTestId(`app-list-row-${appAddress}-${selector}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      const [daGas, l2Gas, hasPublicCallStr] = await Promise.all([
        row.getAttribute("data-gas-da"),
        row.getAttribute("data-gas-l2"),
        row.getAttribute("data-has-public-call"),
      ]);
      if (daGas == null || l2Gas == null || hasPublicCallStr == null) {
        throw new Error(`Missing gas data attrs on row ${appAddress}:${selector}`);
      }
      return {
        gasLimits: { daGas: Number(daGas), l2Gas: Number(l2Gas) },
        hasPublicCall: hasPublicCallStr === "true",
      };
    };
    const popInfo = await readGasInfo(swap.pop, popSelector.toString());
    const ammInfo = await readGasInfo(swap.amm, ammSelector.toString());
    const tokenInfo = await readGasInfo(swap.goCoin, tokenSelector.toString());

    const swapConfig = JSON.parse(await readFile(SWAP_LOCAL_JSON, "utf-8"));
    swapConfig.subscriptionFPC = {
      address: fpc.fpcAddress,
      secretKey: fpc.fpcSecretKey,
      functions: {
        [swap.pop]: {
          [popSelector.toString()]: {
            configIndex: 0,
            gasLimits: popInfo.gasLimits,
            hasPublicCall: popInfo.hasPublicCall,
          },
        },
        [swap.amm]: {
          [ammSelector.toString()]: {
            configIndex: 0,
            gasLimits: ammInfo.gasLimits,
            hasPublicCall: ammInfo.hasPublicCall,
          },
        },
        [swap.goCoin]: {
          [tokenSelector.toString()]: {
            configIndex: 0,
            gasLimits: tokenInfo.gasLimits,
            hasPublicCall: tokenInfo.hasPublicCall,
          },
        },
      },
    };
    await writeFile(SWAP_LOCAL_JSON, JSON.stringify(swapConfig, null, 2), "utf-8");
    console.log(`[e2e] patched ${SWAP_LOCAL_JSON} with subscriptionFPC`);

    // ── 5. Persist spec-04 output into fpc.json ──────────────────────
    const updatedFpc: FpcState = {
      ...fpc,
      signedUp: {
        "pop:check_password_and_mint": {
          contractAddress: swap.pop,
          functionName: "check_password_and_mint",
          selector: popSelector.toString(),
          configIndex: 0,
        },
        "amm:swap_tokens_for_exact_tokens_from": {
          contractAddress: swap.amm,
          functionName: "swap_tokens_for_exact_tokens_from",
          selector: ammSelector.toString(),
          configIndex: 0,
        },
        "goCoin:transfer_in_private_with_offchain_delivery": {
          contractAddress: swap.goCoin,
          functionName: "transfer_in_private_with_offchain_delivery",
          selector: tokenSelector.toString(),
          configIndex: 0,
        },
      },
    };
    await writeState(STATE_FILES.fpc, updatedFpc);
    await writeState(STATE_FILES.fpcSignedUp, {
      signedUpAt: new Date().toISOString(),
      apps: Object.keys(updatedFpc.signedUp ?? {}),
    });
  });
});
