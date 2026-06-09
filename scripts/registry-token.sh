#!/usr/bin/env bash
# Print a short-lived Google Artifact Registry access token for the private
# @aztec npm registry. The token lasts ~1h; mint a fresh one when it expires.
#
# Usage (local):
#   export AZTEC_NPM_TOKEN="$(bash scripts/registry-token.sh)"
# CI (GitHub Actions) typically uses google-github-actions/auth instead, but
# this also works:
#   echo "AZTEC_NPM_TOKEN=$(bash scripts/registry-token.sh)" >> "$GITHUB_ENV"
#
# Auth source, in order:
#   1. $GCP_SA_KEY_FILE — path to a service-account JSON key
#      (default: .secrets/gcp-sa.json; gitignored — never commit it)
#   2. otherwise the caller's active gcloud account (interactive login)
#
# When a key file is used we run gcloud in an isolated CLOUDSDK_CONFIG so the
# service account is NOT made the active account in your normal gcloud config.
set -euo pipefail

# Use $GCP_SA_KEY_FILE if set, else auto-detect the first *.json in .secrets/.
KEY="${GCP_SA_KEY_FILE:-}"
if [ -z "$KEY" ]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  KEY="$(ls "$REPO_ROOT"/.secrets/*.json 2>/dev/null | head -1)"
fi

command -v gcloud >/dev/null || { echo "registry-token: gcloud not found on PATH" >&2; exit 1; }

if [ -f "$KEY" ]; then
  CFG="$(mktemp -d)"
  trap 'rm -rf "$CFG"' EXIT
  CLOUDSDK_CONFIG="$CFG" gcloud auth activate-service-account --key-file="$KEY" --quiet >&2
  CLOUDSDK_CONFIG="$CFG" gcloud auth print-access-token
else
  echo "registry-token: no key at \$GCP_SA_KEY_FILE ($KEY); using active gcloud account" >&2
  gcloud auth print-access-token
fi
