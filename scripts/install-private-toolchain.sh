#!/usr/bin/env bash
# Assemble an Aztec toolchain version dir for a PRIVATE nightly that is not
# published to public npm / install.aztec.network. Works identically locally
# and in CI. Run from anywhere:  bash scripts/install-private-toolchain.sh
#
# Sources (no reliance on the private repo's *compiled* outputs):
#   nargo + noir-profiler          public noir-lang/noir release via noirup
#   bb (native)                    bundled inside the @aztec/bb.js npm tarball
#   aztec CLI / pxe / txe / wallet  private @aztec npm registry
#   foundry (anvil/cast/forge/...)  public foundryup (or a cached copy)
#
# Auth: the private @aztec registry needs AZTEC_NPM_TOKEN. If it is unset we
# mint one from a gcloud service-account key via scripts/registry-token.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

VERSION="$(node -p "require('./apps/bridge/package.json').dependencies['@aztec/aztec.js'].replace(/^v/,'')")"
YARN_VERSION="$(node -p "require('./package.json').packageManager.replace(/^yarn@/,'')")"

AZTEC_HOME="${AZTEC_HOME:-$HOME/.aztec}"
DIR="$AZTEC_HOME/versions/$VERSION"
FOUNDRY_BINS="anvil cast chisel forge"

# Native toolchain versions are NOT committed to a file — they are derived from
# the private aztec-packages-private repo at this nightly's tag:
#   noir    = the noir/noir-repo submodule pin, resolved to its public
#             noir-lang/noir release tag (noirup-installable)
#   foundry = `foundry_version=` in the repo's bootstrap.sh
# Source: GitHub API (gh token), falling back to a local clone if present.
PRIV_REPO="AztecProtocol/aztec-packages-private"
GH_API="https://api.github.com/repos/$PRIV_REPO/contents"
LOCAL_PRIV="${LOCAL_PRIV:-$HOME/Repos/aztec-packages-private}"

derive_versions() {
  local tag="v$VERSION" tok meta raw noir_sha refs sha ref
  tok="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  [ -z "$tok" ] && command -v gh >/dev/null 2>&1 && tok="$(gh auth token 2>/dev/null || true)"

  if [ -n "$tok" ]; then
    echo ">> deriving toolchain versions for $tag via GitHub API"
    meta="$(curl -fsSL -H "Authorization: Bearer $tok" "$GH_API/noir/noir-repo?ref=$tag")"
    raw="$(curl -fsSL -H "Authorization: Bearer $tok" -H 'Accept: application/vnd.github.raw' "$GH_API/bootstrap.sh?ref=$tag")"
  elif [ -d "$LOCAL_PRIV/.git" ]; then
    echo ">> deriving toolchain versions for $tag from local clone $LOCAL_PRIV"
    git -C "$LOCAL_PRIV" fetch --quiet origin tag "$tag" 2>/dev/null || true
    meta="$(git -C "$LOCAL_PRIV" ls-tree "$tag" noir/noir-repo)"   # "<mode> commit <sha>\tnoir/noir-repo"
    raw="$(git -C "$LOCAL_PRIV" show "$tag:bootstrap.sh")"
  else
    echo "ERROR: need a gh token (GH_TOKEN / 'gh auth login') or a clone at $LOCAL_PRIV to derive versions for $tag" >&2
    exit 1
  fi

  # noir submodule commit: from API JSON ("sha":"…") or from `git ls-tree`
  if   [[ "$meta" =~ \"sha\"[[:space:]]*:[[:space:]]*\"([0-9a-f]{40})\" ]]; then noir_sha="${BASH_REMATCH[1]}"
  elif [[ "$meta" =~ ([0-9a-f]{40}) ]];                                     then noir_sha="${BASH_REMATCH[1]}"; fi
  [ -n "${noir_sha:-}" ] || { echo "ERROR: could not read noir-repo pin at $tag" >&2; exit 1; }

  # foundry version from bootstrap.sh (foundry_version=1.4.1)
  [[ "$raw" =~ foundry_version=([0-9.]+) ]] && FOUNDRY_VERSION="${BASH_REMATCH[1]}"
  [ -n "${FOUNDRY_VERSION:-}" ] || { echo "ERROR: could not derive FOUNDRY_VERSION from $tag:bootstrap.sh" >&2; exit 1; }

  # resolve the noir commit to its public noir-lang/noir release tag (pure-bash, no early-exit pipes)
  refs="$(git ls-remote --tags https://github.com/noir-lang/noir)"
  NOIR_VERSION=""
  while read -r sha ref; do
    [ "$sha" = "$noir_sha" ] || continue
    ref="${ref#refs/tags/}"; ref="${ref%^\{\}}"
    NOIR_VERSION="$ref"; break
  done <<< "$refs"
  [ -n "$NOIR_VERSION" ] || { echo "ERROR: noir commit $noir_sha is not a public noir-lang/noir tag" >&2; exit 1; }
}
derive_versions

echo ">> aztec=$VERSION  noir=$NOIR_VERSION  foundry=$FOUNDRY_VERSION"
echo ">> target: $DIR"

# --- preconditions / auth ---
for c in node npm curl tar; do command -v "$c" >/dev/null || { echo "ERROR: $c not found"; exit 1; }; done
if [ -z "${AZTEC_NPM_TOKEN:-}" ]; then
  echo ">> minting AZTEC_NPM_TOKEN via scripts/registry-token.sh"
  AZTEC_NPM_TOKEN="$(bash "$REPO/scripts/registry-token.sh")"
  export AZTEC_NPM_TOKEN
fi
[ -n "${AZTEC_NPM_TOKEN:-}" ] || { echo "ERROR: empty AZTEC_NPM_TOKEN"; exit 1; }

# --- clean + scaffold ---
rm -rf "$DIR"
mkdir -p "$DIR/internal-bin" "$DIR/bin"

# --- 1. nargo + noir-profiler from the public noir release -------------------
echo ">> installing nargo '$NOIR_VERSION' from public noir-lang/noir"
if [ ! -x "$HOME/.nargo/bin/noirup" ]; then
  curl -fsSL https://raw.githubusercontent.com/noir-lang/noirup/refs/heads/main/install | bash >/dev/null
fi
NARGO_TMP="$(mktemp -d)"
if ! { NARGO_HOME="$NARGO_TMP" "$HOME/.nargo/bin/noirup" -v "$NOIR_VERSION" >/dev/null 2>&1 && [ -x "$NARGO_TMP/bin/nargo" ]; }; then
  # noirup can't always resolve a non-semver release tag — fetch the asset directly.
  echo "   noirup could not resolve '$NOIR_VERSION'; downloading release asset directly"
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64)   TGT=aarch64-apple-darwin ;;
    Darwin-x86_64)  TGT=x86_64-apple-darwin ;;
    Linux-aarch64)  TGT=aarch64-unknown-linux-gnu ;;
    *)              TGT=x86_64-unknown-linux-gnu ;;
  esac
  mkdir -p "$NARGO_TMP/bin"
  curl -fsSL "https://github.com/noir-lang/noir/releases/download/$NOIR_VERSION/nargo-$TGT.tar.gz" \
    | tar xz -C "$NARGO_TMP/bin"
fi
cp "$NARGO_TMP/bin/nargo" "$DIR/internal-bin/nargo"
if [ -x "$NARGO_TMP/bin/noir-profiler" ]; then
  cp "$NARGO_TMP/bin/noir-profiler" "$DIR/internal-bin/noir-profiler"
else
  echo "   (noir-profiler not in release — skipping; not needed for compile/codegen)"
fi
rm -rf "$NARGO_TMP"

# --- 2. @aztec/aztec + bb.js (native bb) + cli-wallet from the PRIVATE registry
# Installed with yarn (node-modules linker) into the version dir — same package
# manager as the workspace. The generated .yarnrc.yml references the token via
# ${AZTEC_NPM_TOKEN}, so no secret is written to disk.
echo ">> yarn install @aztec/{aztec,bb.js,cli-wallet}@$VERSION from the private registry"
# Pin packageManager so corepack runs Yarn Berry here (not a stray global
# Yarn Classic, which ignores .yarnrc.yml npmScopes and hits public npm).
cat > "$DIR/package.json" <<EOF
{
  "packageManager": "yarn@$YARN_VERSION",
  "dependencies": {
    "@aztec/aztec": "$VERSION",
    "@aztec/bb.js": "$VERSION",
    "@aztec/cli-wallet": "$VERSION"
  }
}
EOF
cat > "$DIR/.yarnrc.yml" <<EOF
nodeLinker: node-modules
# This is an isolated, exact-pinned install from the private registry (not the
# workspace), and it legitimately creates a fresh lockfile here. Yarn auto-
# enables hardened mode under PR events and would block that (YN0028), so turn
# it off for this throwaway toolchain dir.
enableHardenedMode: false
npmScopes:
  aztec:
    npmRegistryServer: "https://us-west1-npm.pkg.dev/testnet-440309/aztec-npm"
    npmAlwaysAuth: true
    npmAuthToken: "\${AZTEC_NPM_TOKEN}"
EOF
( cd "$DIR" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack yarn install )

# --- 3. foundry (anvil/cast/forge/chisel) ------------------------------------
echo ">> installing foundry $FOUNDRY_VERSION"
FOUNDRY_SRC=""
for cand in "$AZTEC_HOME"/.toolchain-template/internal-bin "$AZTEC_HOME"/versions/*/internal-bin "$HOME/.foundry/bin"; do
  [ -x "$cand/anvil" ] && { FOUNDRY_SRC="$cand"; break; }
done
if [ -n "$FOUNDRY_SRC" ]; then
  echo "   reusing foundry from $FOUNDRY_SRC"
  for f in $FOUNDRY_BINS; do cp "$FOUNDRY_SRC/$f" "$DIR/internal-bin/$f"; done
else
  FOUNDRY_TMP="$(mktemp -d)"
  curl -fsSL https://foundry.paradigm.xyz | FOUNDRY_DIR="$FOUNDRY_TMP" bash >/dev/null
  FOUNDRY_DIR="$FOUNDRY_TMP" "$FOUNDRY_TMP/bin/foundryup" --install "$FOUNDRY_VERSION" >/dev/null
  for f in $FOUNDRY_BINS; do cp "$FOUNDRY_TMP/bin/$f" "$DIR/internal-bin/$f"; done
  rm -rf "$FOUNDRY_TMP"
fi

# --- 4. bin/ : the `aztec` wrapper + aztec-* symlinks ------------------------
echo ">> generating bin/ wrappers + symlinks"
cat > "$DIR/bin/aztec" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
self_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$self_dir/../internal-bin:$PATH"
exec "$self_dir/../node_modules/.bin/aztec" "$@"
EOF
chmod +x "$DIR/bin/aztec"
# native tools -> internal-bin (aztec-nargo, aztec-anvil, ...)
for f in "$DIR"/internal-bin/*; do
  name="$(basename "$f")"
  ln -sf "../internal-bin/$name" "$DIR/bin/aztec-$name"
done
# js CLIs -> node_modules/.bin. Names already prefixed with `aztec-` (e.g.
# aztec-wallet) are linked verbatim; the `aztec` CLI is served by the wrapper.
if [ -d "$DIR/node_modules/.bin" ]; then
  for f in "$DIR"/node_modules/.bin/*; do
    name="$(basename "$f")"
    case "$name" in
      aztec)   continue ;;
      aztec-*) link="$name" ;;
      *)       link="aztec-$name" ;;
    esac
    ln -sf "../node_modules/.bin/$name" "$DIR/bin/$link"
  done
fi

# --- 5. version manifest + activate -----------------------------------------
cat > "$DIR/versions" <<EOF
noir: $NOIR_VERSION
foundry: $FOUNDRY_VERSION
EOF
ln -sfn "$DIR" "$AZTEC_HOME/current"

echo ">> activated $VERSION as $AZTEC_HOME/current"
"$DIR/bin/aztec-nargo" --version | head -1
echo ">> done"
