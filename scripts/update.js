#!/usr/bin/env node

/**
 * Update aztec-kit to a given Aztec version (nightly or RC) across the whole monorepo.
 *
 * Scope:
 *   - every workspace package.json under apps/, packages/, e2e/: `@aztec-labs/*` pins are set
 *     to VERSION; `@aztec-foundation/*` pins (bb.js, l1-artifacts, noir-*) are on their own
 *     version line and are set to whatever `@aztec-labs/*@VERSION` itself depends on
 *   - root `resolutions` that yarn-patch an Aztec package: carried over to VERSION
 *   - `.aztecrc` (the Aztec CLI toolchain pin)
 *   - every Nargo.toml under packages/contracts/aztec/noir/
 *
 * Usage:
 *   node scripts/update.js [--version VERSION] [--major N] [--channel nightly|rc]
 *                          [--skip-aztec-up] [--skip-compile]
 *
 * When `--version` is omitted, the script auto-fetches the latest release of the tracked
 * major + channel. Both default to what the current `@aztec-labs/aztec.js` pin in any
 * workspace package.json is on (e.g. `6.0.0-rc.1` → v6 RCs), so each branch keeps
 * following its own stream automatically.
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

function updatePackageJsonFiles(version, foundationVersion) {
  log(COLORS.yellow, "[1/6] Updating workspace package.json files...");

  const packageJsons = findWorkspacePackageJsons();
  let changed = 0;

  for (const path of packageJsons) {
    const original = readFileSync(path, "utf-8");
    const updated = original
      .replace(/"(@aztec-labs\/[^"]+)": "[^"]+"/g, `"$1": "${version}"`)
      .replace(/"(@aztec-foundation\/[^"]+)": "[^"]+"/g, `"$1": "${foundationVersion}"`);
    if (updated !== original) {
      writeFileSync(path, updated, "utf-8");
      log(COLORS.green, `  ✓ ${relative(ROOT, path)}`);
      changed++;
    }
  }

  log(COLORS.green, `✓ Updated ${changed} package.json file(s)\n`);
}

/**
 * Carries the root `resolutions` that yarn-patch an Aztec package over to the new version, so a
 * bump keeps applying them instead of silently dropping them (a resolution keyed on the old
 * version no longer matches anything). If a patch no longer applies to the new version,
 * `yarn install` fails on it — drop or regenerate it then, and delete it outright once upstream
 * ships the change it carries.
 */
function updatePatchedResolutions(version, foundationVersion) {
  const path = resolve(ROOT, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf-8"));
  if (!pkg.resolutions) return;

  const bump = (s) =>
    s
      .replace(/(@aztec-labs\/[^@"#]+@npm(?::|%3A))[^"#]+/g, `$1${version}`)
      .replace(/(@aztec-foundation\/[^@"#]+@npm(?::|%3A))[^"#]+/g, `$1${foundationVersion}`);
  const resolutions = {};
  const patched = [];
  for (const [key, value] of Object.entries(pkg.resolutions)) {
    resolutions[bump(key)] = bump(value);
    if (value.startsWith("patch:") && bump(key) !== key) patched.push(key.replace(/@npm:.*/, ""));
  }
  if (patched.length === 0) return;

  pkg.resolutions = resolutions;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
  log(
    COLORS.yellow,
    `  ! Carried yarn patches over to the new version: ${patched.join(", ")} (.yarn/patches/).` +
      " Drop each once upstream ships its change.\n",
  );
}

/**
 * Pins the Aztec CLI toolchain to the same version as the npm packages.
 *
 * `aztec-up install` (see {@link installAztecCLI}) only moves the global
 * `~/.aztec/current` symlink; the repo-local pin the version manager actually
 * reads is this file, so without writing it the CLI keeps resolving whatever
 * version was last recorded here while the workspace builds against another.
 * Written bare (no `v`) and without a trailing newline, which is the format
 * the version manager writes.
 */
function updateAztecRc(version) {
  log(COLORS.yellow, "[2/6] Updating .aztecrc...");

  const rcPath = resolve(ROOT, ".aztecrc");
  const current = isFile(rcPath) ? readFileSync(rcPath, "utf-8").trim() : undefined;

  if (current === version) {
    log(COLORS.green, `✓ .aztecrc already at ${version}\n`);
    return;
  }

  writeFileSync(rcPath, version, "utf-8");
  log(COLORS.green, `  ✓ .aztecrc (${current ?? "absent"} → ${version})\n`);
}

function updateNargoToml(version) {
  log(COLORS.yellow, "[3/6] Updating Nargo.toml files...");

  const contractsDir = resolve(ROOT, "packages/contracts/aztec/noir");
  const nargoFiles = findNargoTomlFiles(contractsDir);
  let changed = 0;

  for (const nargoPath of nargoFiles) {
    let content = readFileSync(nargoPath, "utf-8");
    const original = content;

    // aztec-nr mirror (aztec, uint-note, compressed-string, ...) and the aztec-node monorepo
    // (token / account contracts)
    content = content.replace(
      /(git\s*=\s*"https:\/\/github\.com\/aztec-labs-eng\/aztec-(?:nr|node)\/?",?\s*tag\s*=\s*")v[^"]+"/g,
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
  log(COLORS.yellow, "[4/6] Running yarn install...");
  exec("yarn install");
  log(COLORS.green, "✓ Dependencies installed\n");
}

function installAztecCLI(version) {
  log(COLORS.yellow, `[5/6] Installing Aztec CLI version ${version}...`);

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
      `curl -fsSL "https://install.aztec-labs.com/${version}/install" | VERSION="${version}" bash`,
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
  log(COLORS.yellow, "[6/6] Building @aztec-kit/contracts-aztec (compile + codegen)...");
  exec("yarn workspace @aztec-kit/contracts-aztec build");
  log(COLORS.green, "✓ Contracts compiled\n");
}

/**
 * Reads `@aztec-labs/aztec.js`'s current pin from any workspace package.json and
 * returns its major and channel (e.g. `"6.0.0-rc.1"` → `{ major: 6, channel: "rc" }`).
 * Used to pick which release series to track when the caller doesn't pass
 * `--major` / `--channel`.
 */
function inferSeriesFromPin() {
  for (const path of findWorkspacePackageJsons()) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    const pin =
      pkg.dependencies?.["@aztec-labs/aztec.js"] || pkg.devDependencies?.["@aztec-labs/aztec.js"];
    const m = pin?.match(/^v?(\d+)\.\d+\.\d+-(nightly|rc)\./);
    if (m) return { major: Number(m[1]), channel: m[2] };
  }
  return null;
}

async function fetchLatestRelease(major, channel) {
  log(COLORS.yellow, `Fetching latest v${major} ${channel} from npm...`);
  try {
    // `npm view ... versions` is semver-sorted, so rc.10 lands after rc.9.
    const output = exec("npm view @aztec-labs/aztec.js versions --json", { silent: true });
    const versions = JSON.parse(output);
    const re = new RegExp(`^${major}\\.\\d+\\.\\d+-${channel}\\.\\d+$`);
    const matching = versions.filter((v) => re.test(v));
    const latest = matching[matching.length - 1];
    if (!latest) throw new Error(`No v${major} ${channel} versions found`);
    return latest;
  } catch {
    log(COLORS.red, `Failed to fetch latest v${major} ${channel} from npm`);
    log(COLORS.red, "Please specify a version with --version");
    process.exit(1);
  }
}

/**
 * Resolves the `@aztec-foundation/*` version that `@aztec-labs/*@version` was released
 * against. The foundation packages are versioned independently (e.g. labs `6.0.0-rc.3`
 * depends on foundation `6.0.0-rc.6`), so a direct foundation pin has to follow the labs
 * packages' own dependency rather than reuse the labs version — anything else either 404s
 * or puts a second bb.js/acvm build in the tree.
 */
function resolveFoundationVersion(version) {
  const found = new Set();
  for (const pkg of ["@aztec-labs/aztec.js", "@aztec-labs/stdlib", "@aztec-labs/pxe"]) {
    const output = exec(`npm view ${pkg}@${version} dependencies --json`, { silent: true });
    for (const [name, range] of Object.entries(JSON.parse(output || "{}"))) {
      if (name.startsWith("@aztec-foundation/")) found.add(range);
    }
  }
  if (found.size !== 1) {
    log(
      COLORS.red,
      `Could not resolve a single @aztec-foundation version for v${version} (found: ${[...found].join(", ") || "none"})`,
    );
    process.exit(1);
  }
  return [...found][0];
}

function parseArgs() {
  const args = process.argv.slice(2);
  let version = null;
  let major = null;
  let channel = null;
  let skipAztecUp = false;
  let skipCompile = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--version" && args[i + 1]) {
      version = args[++i].replace(/^v/, "");
    } else if (a === "--major" && args[i + 1]) {
      major = Number(args[++i]);
    } else if (a === "--channel" && args[i + 1]) {
      channel = args[++i];
      if (channel !== "nightly" && channel !== "rc") {
        log(COLORS.red, `Unknown channel "${channel}" (expected nightly or rc)`);
        process.exit(1);
      }
    } else if (a === "--skip-aztec-up") {
      skipAztecUp = true;
    } else if (a === "--skip-compile") {
      skipCompile = true;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: node scripts/update.js [OPTIONS]");
      console.log("\nOptions:");
      console.log(
        "  --version VERSION    Specify version (e.g., 6.0.0-rc.3 or 6.0.0-nightly.20261021)",
      );
      console.log(
        "  --major N            Track v<N> releases (default: inferred from current pin)",
      );
      console.log(
        "  --channel C          Track `nightly` or `rc` releases (default: inferred from current pin)",
      );
      console.log("  --skip-aztec-up      Skip Aztec CLI installation");
      console.log("  --skip-compile       Skip the compile/codegen step at the end");
      console.log("  --help, -h           Show this help message");
      process.exit(0);
    }
  }

  return { version, major, channel, skipAztecUp, skipCompile };
}

async function main() {
  log(COLORS.green, "=== Aztec-Kit Update Script ===\n");

  let { version, major, channel, skipAztecUp, skipCompile } = parseArgs();

  if (!version) {
    if (!major || !channel) {
      const inferred = inferSeriesFromPin();
      if (!inferred) {
        log(
          COLORS.red,
          "Could not infer the release series from workspace pins. Pass --major and --channel, or --version.",
        );
        process.exit(1);
      }
      major ??= inferred.major;
      channel ??= inferred.channel;
      log(
        COLORS.green,
        `Tracking v${major} ${channel} (inferred from current @aztec-labs/aztec.js pin)\n`,
      );
    }
    version = await fetchLatestRelease(major, channel);
    log(COLORS.green, `Latest ${channel} version: v${version}\n`);
  } else {
    log(COLORS.green, `Updating to version: v${version}\n`);
  }

  const foundationVersion = resolveFoundationVersion(version);
  log(COLORS.green, `@aztec-foundation/* version for v${version}: ${foundationVersion}\n`);

  updatePackageJsonFiles(version, foundationVersion);
  updatePatchedResolutions(version, foundationVersion);
  updateAztecRc(version);
  updateNargoToml(version);
  installDependencies();

  if (skipAztecUp) {
    log(COLORS.yellow, "[5/6] Skipping Aztec CLI installation (--skip-aztec-up)\n");
  } else {
    installAztecCLI(version);
  }

  if (skipCompile) {
    log(COLORS.yellow, "[6/6] Skipping contract compile (--skip-compile)\n");
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
