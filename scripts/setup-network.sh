#!/usr/bin/env bash
# Orchestrates a full swap-app deploy on the target network:
#
#   1. Deploy the swap admin (generates SWAP_ADMIN_SECRET if not set).
#      On the local network: via SponsoredFPC. On remote networks: bridge + claim + deploy.
#   2. Deploy swap contracts with that admin.
#   3. Deploy the FPC admin (generates FPC_ADMIN_SECRET if not set). Same
#      sponsoredfpc-vs-bridge split as step 1.
#   4. Deploy the SubscriptionFPC and fund it with a bridged FJ balance.
#   5. Register the swap-app signups on the FPC (calibrate on remote networks).
#
# Each step's stdout contains `export KEY=VAL` lines for the next step; we
# capture them by eval-ing the greppable subset of output.
#
# Supply `SWAP_ADMIN_SECRET` / `FPC_ADMIN_SECRET` via env to make the flow deterministic.
# Optional: `L1_FUNDER_KEY` to avoid the faucet mint.

set -euo pipefail

NETWORK="${1:-}"
if [ -z "${NETWORK}" ]; then
  echo "usage: $0 <network>" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"

echo_stage() { printf "\n=== %s ===\n" "$1"; }

# Runs a yarn script, streams stderr, captures stdout, and evals any
# `export KEY=…` lines from stdout into this shell's environment.
run_and_capture() {
  local label="$1"; shift
  echo_stage "${label}"
  local out
  # Use tee to show stdout live while also capturing it.
  out=$( { "$@" 2>&1 >&3 | tee /dev/stderr >&4; } 3>&1 4>/dev/null )
  while IFS= read -r line; do
    case "${line}" in
      "export "*) eval "${line}" ;;
    esac
  done <<< "${out}"
}

run_and_capture "Deploy swap admin (${NETWORK})" \
  yarn workspace @aztec-kit/swap "deploy-admin:${NETWORK}"

run_and_capture "Deploy swap contracts (${NETWORK})" \
  yarn workspace @aztec-kit/swap "deploy:${NETWORK}"

run_and_capture "Deploy FPC admin (${NETWORK})" \
  yarn workspace @aztec-kit/fpc-operator "deploy-admin:${NETWORK}"

run_and_capture "Deploy FPC + fund FPC (${NETWORK})" \
  yarn workspace @aztec-kit/fpc-operator "deploy-fpc:${NETWORK}"

# Calibration of the AMM/Token signups simulates a swap from the FPC admin,
# so it needs a GoCoin + GoCoinPremium balance. Mint from swap-admin
# (the Token's owner) to the FPC admin before calibrating.
run_and_capture "Mint swap tokens to FPC admin (${NETWORK})" \
  yarn workspace @aztec-kit/swap "mint:${NETWORK}" --to "${FPC_ADMIN_ADDRESS}"

run_and_capture "Register swap FPC signups (${NETWORK})" \
  yarn workspace @aztec-kit/swap "register-fpc-signups:${NETWORK}"

echo_stage "Done"
echo "Swap admin: ${SWAP_ADMIN_ADDRESS:-?}"
echo "FPC admin:  ${FPC_ADMIN_ADDRESS:-?}"
echo "FPC:        ${FPC_ADDRESS:-?}"
echo "FPC secret: ${FPC_SECRET:-?}"
