#!/usr/bin/env node

/**
 * Update aztec-kit to a given Aztec nightly version across the whole monorepo.
 *
 * Scope:
 *   - every workspace package.json under apps/, packages/, e2e/
 *   - every Nargo.toml under packages/contracts/aztec/noir/
 *
 * Usage:
 *   node scripts/update.js [--version VERSION] [--major N] [--skip-aztec-up] [--skip-compile]
 *
 * When `--version` is omitted, the script auto-fetches the latest nightly. The
 * major series tracked is taken from `--major` if passed, otherwise inferred
 * from the current `@aztec/aztec.js` pin in any workspace package.json — so
 * `main` (v4) and `next` (v5) each track their own stream automatically.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join, relative } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const WORKSPACE_ROOTS = ["apps", "packages", "packages/contracts", "e2e"];

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

function log(color, message) {
  console.log(`${color}${message}${COLORS.reset}`);
}

function exec(command, options = {}) {
  return execSync(command, {
    cwd: options.cwd || ROOT,
    stdio: options.silent ? "pipe" : "inherit",
    encoding: "utf-8",
    ...options,
  });
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Returns every package.json under the given workspace roots.
 * Handles two layouts:
 *   - `e2e/package.json` (single workspace at the root of its dir)
 *   - `apps/<name>/package.json` / `packages/<name>/package.json` (children)
 */
function findWorkspacePackageJsons() {
  const results = [];
  for (const root of WORKSPACE_ROOTS) {
    const rootPath = resolve(ROOT, root);
    if (!isDir(rootPath)) continue;

    const topLevelPkg = join(rootPath, "package.json");
    if (isFile(topLevelPkg)) {
      results.push(topLevelPkg);
      continue;
    }

    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(rootPath, entry.name, "package.json");
      if (isFile(pkgPath)) results.push(pkgPath);
    }
  }
  return results;
}

function findNargoTomlFiles(dir) {
  const results = [];
  if (!isDir(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "target") {
      results.push(...findNargoTomlFiles(fullPath));
    } else if (entry.name === "Nargo.toml") {
      results.push(fullPath);
    }
  }
  return results;
}

function updatePackageJsonFiles(version) {
  log(COLORS.yellow, "[1/5] Updating workspace package.json files...");

  const packageJsons = findWorkspacePackageJsons();
  let changed = 0;

  for (const path of packageJsons) {
    const original = readFileSync(path, "utf-8");
    const updated = original.replace(/"(@aztec\/[^"]+)": "v[^"]+"/g, `"$1": "v${version}"`);
    if (updated !== original) {
      writeFileSync(path, updated, "utf-8");
      log(COLORS.green, `  ✓ ${relative(ROOT, path)}`);
      changed++;
    }
  }

  log(COLORS.green, `✓ Updated ${changed} package.json file(s)\n`);
}

function updateNargoToml(version) {
  log(COLORS.yellow, "[2/5] Updating Nargo.toml files...");

  const contractsDir = resolve(ROOT, "packages/contracts/aztec/noir");
  const nargoFiles = findNargoTomlFiles(contractsDir);
  let changed = 0;

  for (const nargoPath of nargoFiles) {
    let content = readFileSync(nargoPath, "utf-8");
    const original = content;

    // aztec-nr
    content = content.replace(
      /(git\s*=\s*"https:\/\/github\.com\/AztecProtocol\/aztec-nr"[^}]*tag\s*=\s*")v[^"]+"/g,
      `$1v${version}"`,
    );
    // aztec-packages
    content = content.replace(
      /(git\s*=\s*"https:\/\/github\.com\/AztecProtocol\/aztec-packages\/?",?\s*tag\s*=\s*")v[^"]+"/g,
      `$1v${version}"`,
    );

    if (content !== original) {
      writeFileSync(nargoPath, content, "utf-8");
      log(COLORS.green, `  ✓ ${relative(ROOT, nargoPath)}`);
      changed++;
    }
  }

  log(COLORS.green, `✓ Updated ${changed} Nargo.toml file(s)\n`);
}

function installDependencies() {
  log(COLORS.yellow, "[3/5] Running yarn install...");
  exec("yarn install");
  log(COLORS.green, "✓ Dependencies installed\n");
}

function installAztecCLI(version) {
  log(COLORS.yellow, `[4/5] Installing Aztec CLI version ${version}...`);

  try {
    const current = exec("aztec --version", { silent: true }).trim();
    if (current === version) {
      log(COLORS.green, `✓ Aztec CLI already at v${version}, skipping\n`);
      return;
    }
  } catch {
    // not installed yet — proceed
  }

  const isCI = !!process.env.CI;

  if (isCI) {
    log(COLORS.yellow, `Running version-specific installer for ${version}...`);
    process.env.FOUNDRY_DIR = `${process.env.HOME}/.foundry`;
    exec(
      `curl -fsSL "https://install.aztec.network/${version}/install" | VERSION="${version}" bash`,
    );
    // `internal-bin` holds nargo + foundry binaries since
    // v4.3.0-nightly.20260512-1 — the installer's shell-wrapper `aztec`
    // prepends it for subprocesses, but the npm-shipped CLI (which our
    // contracts build uses) doesn't, so we add it explicitly.
    process.env.PATH = `${process.env.HOME}/.aztec/versions/${version}/bin:${process.env.PATH}`;
    process.env.PATH = `${process.env.HOME}/.aztec/versions/${version}/internal-bin:${process.env.PATH}`;
    process.env.PATH = `${process.env.HOME}/.aztec/versions/${version}/node_modules/.bin:${process.env.PATH}`;
    log(COLORS.green, "✓ Aztec CLI installed (CI mode)\n");
    return;
  }

  try {
    exec("command -v aztec-up", { silent: true });
    exec(`aztec-up install ${version}`);
    log(COLORS.green, "✓ Aztec CLI updated\n");
  } catch {
    log(
      COLORS.red,
      `Warning: aztec-up not found in PATH. Install manually: aztec-up install ${version}\n`,
    );
  }
}

function compileContracts() {
  log(COLORS.yellow, "[5/5] Building @aztec-kit/contracts-aztec (compile + codegen)...");
  exec("yarn workspace @aztec-kit/contracts-aztec build");
  log(COLORS.green, "✓ Contracts compiled\n");
}

/**
 * Reads `@aztec/aztec.js`'s current pin from any workspace package.json and
 * returns its leading major (e.g. `"v4.3.0-rc.1"` → `4`). Used to pick which
 * nightly series to track when the caller doesn't pass `--major`.
 */
function inferMajorFromPin() {
  for (const path of findWorkspacePackageJsons()) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    const pin = pkg.dependencies?.["@aztec/aztec.js"] || pkg.devDependencies?.["@aztec/aztec.js"];
    const m = pin?.match(/^v?(\d+)\./);
    if (m) return Number(m[1]);
  }
  return null;
}

async function fetchLatestNightly(major) {
  log(COLORS.yellow, `Fetching latest v${major} nightly from npm...`);
  try {
    const output = exec("npm view @aztec/aztec.js versions --json", { silent: true });
    const versions = JSON.parse(output);
    const re = new RegExp(`^${major}\\.\\d+\\.\\d+-nightly\\.\\d+$`);
    const nightlies = versions.filter((v) => re.test(v));
    const latest = nightlies[nightlies.length - 1];
    if (!latest) throw new Error(`No v${major} nightly versions found`);
    return latest;
  } catch {
    log(COLORS.red, `Failed to fetch latest v${major} nightly from npm`);
    log(COLORS.red, "Please specify a version with --version");
    process.exit(1);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let version = null;
  let major = null;
  let skipAztecUp = false;
  let skipCompile = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--version" && args[i + 1]) {
      version = args[++i].replace(/^v/, "");
    } else if (a === "--major" && args[i + 1]) {
      major = Number(args[++i]);
    } else if (a === "--skip-aztec-up") {
      skipAztecUp = true;
    } else if (a === "--skip-compile") {
      skipCompile = true;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/update.js [OPTIONS]");
      console.log("\nOptions:");
      console.log("  --version VERSION    Specify nightly version (e.g., 5.0.0-nightly.20260512)");
      console.log(
        "  --major N            Track v<N> nightlies (default: inferred from current pin)",
      );
      console.log("  --skip-aztec-up      Skip Aztec CLI installation");
      console.log("  --skip-compile       Skip the compile/codegen step at the end");
      console.log("  --help, -h           Show this help message");
      process.exit(0);
    }
  }

  return { version, major, skipAztecUp, skipCompile };
}

async function main() {
  log(COLORS.green, "=== Aztec-Kit Nightly Update Script ===\n");

  let { version, major, skipAztecUp, skipCompile } = parseArgs();

  if (!version) {
    if (!major) {
      major = inferMajorFromPin();
      if (!major) {
        log(COLORS.red, "Could not infer major from workspace pins. Pass --major or --version.");
        process.exit(1);
      }
      log(COLORS.green, `Inferred major v${major} from current @aztec/aztec.js pin\n`);
    }
    version = await fetchLatestNightly(major);
    log(COLORS.green, `Latest nightly version: v${version}\n`);
  } else {
    log(COLORS.green, `Updating to version: v${version}\n`);
  }

  updatePackageJsonFiles(version);
  updateNargoToml(version);
  installDependencies();

  if (skipAztecUp) {
    log(COLORS.yellow, "[4/5] Skipping Aztec CLI installation (--skip-aztec-up)\n");
  } else {
    installAztecCLI(version);
  }

  if (skipCompile) {
    log(COLORS.yellow, "[5/5] Skipping contract compile (--skip-compile)\n");
  } else {
    compileContracts();
  }

  log(COLORS.green, "=== Update Complete ===");
  log(COLORS.green, `Version: v${version}`);
}

main().catch((error) => {
  log(COLORS.red, `Error: ${error.message}`);
  process.exit(1);
});
