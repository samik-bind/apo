#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDERED_CONFIG_DISABLED="$(mktemp)"
RENDERED_CONFIG_CONFIGURED="$(mktemp)"
trap 'rm -f "$RENDERED_CONFIG_DISABLED" "$RENDERED_CONFIG_CONFIGURED"' EXIT

export AUTH_SECRET="public-ingress-contract-secret"
export APO_PUBLIC_URL="https://apo.example.com"
unset APO_DOCS_HOST

docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/docker-compose.server.yml" \
  config --format json > "$RENDERED_CONFIG_DISABLED"

export APO_DOCS_HOST="docs.apo.example.com"

docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/docker-compose.server.yml" \
  config --format json > "$RENDERED_CONFIG_CONFIGURED"

cd "$REPO_ROOT"
node tests/deployment/public-ingress-contract.mjs \
  "$RENDERED_CONFIG_DISABLED" \
  "$RENDERED_CONFIG_CONFIGURED"
