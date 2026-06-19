/**
 * Orchestrates a full swap-app deploy on the target network — the headless, fully-automatic flow
 * (no browser; the framework bridges its own Fee Juice). App-specific glue; replaces the former
 * setup-network.sh.
 *
 *   1. Deploy swap contracts          (swap deploy)
 *   2. Deploy + fund the FPC          (fpc-operator deploy-fpc)
 *   3. Mint swap tokens to FPC admin  (swap mint)
 *   4. Register the swap-app signups  (swap register-fpc-signups)
 *
 * Each step is a `yarn workspace …` subprocess. Its stderr streams live (the deploy framework's
 * plan/progress reporter lands there); its stdout carries `export KEY=VAL` lines that we capture
 * and feed into later steps' env — the same handoff the shell script did via eval.
 *
 *   node --experimental-transform-types scripts/setup-network.ts <local|testnet>
 *
 * Supply SWAP_ADMIN_SECRET / FPC_ADMIN_SECRET via env to make the flow deterministic;
 * L1_FUNDER_KEY to avoid the faucet mint.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const network = process.argv[2];
if (network !== "local" && network !== "testnet") {
  console.error(`usage: setup-network.ts <local|testnet> (got ${network ?? "nothing"})`);
  process.exit(1);
}

const ROOT = resolve(import.meta.dirname, "..");
const env: NodeJS.ProcessEnv = { ...process.env };

const EXPORT_LINE = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Runs one workspace script, streaming stderr live and capturing stdout. Parsed `export KEY=VAL`
 * lines are merged into `env` for later steps. Exits the process if the step fails.
 */
async function step(label: string, workspace: string, script: string, extraArgs: string[] = []): Promise<void> {
  console.error(`\n=== ${label} (${network}) ===`);
  let stdout = "";
  const exitCode = await new Promise<number>((res, rej) => {
    const child = spawn("yarn", ["workspace", workspace, `${script}:${network}`, ...extraArgs], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", rej);
    child.on("exit", (code) => res(code ?? 1));
  });

  for (const line of stdout.split("\n")) {
    const match = EXPORT_LINE.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }

  if (exitCode !== 0) {
    console.error(`\n✗ ${label} failed (exit ${exitCode})`);
    process.exit(exitCode);
  }
}

await step("Deploy swap contracts", "@aztec-kit/swap", "deploy");
await step("Deploy + fund FPC", "@aztec-kit/fpc-operator", "deploy-fpc");
await step("Mint swap tokens to FPC admin", "@aztec-kit/swap", "mint", ["--to", env.FPC_ADMIN_ADDRESS ?? ""]);
await step("Register swap FPC signups", "@aztec-kit/swap", "register-fpc-signups");

console.error("\n=== Done ===");
console.log(`Swap admin: ${env.SWAP_ADMIN_ADDRESS ?? "?"}`);
console.log(`FPC admin:  ${env.FPC_ADMIN_ADDRESS ?? "?"}`);
console.log(`FPC:        ${env.FPC_ADDRESS ?? "?"}`);
console.log(`FPC secret: ${env.FPC_SECRET ?? "?"}`);
