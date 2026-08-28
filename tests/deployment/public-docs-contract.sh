#!/usr/bin/env bash
# Contract tests for the public docs deployment overlay.
#
# Renders the full tunnel + public-docs Compose stack and asserts the docs
# service, Caddy host routing, and Cloudflare Tunnel ingress match the
# Public HTTP contract — without needing live DNS or the VPS.
#
# Run: bash tests/deployment/public-docs-contract.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDERED_CONFIG="$(mktemp)"
trap 'rm -f "$RENDERED_CONFIG"' EXIT

export AUTH_SECRET="public-docs-contract-secret"
export APO_PUBLIC_URL="https://test-apo.online"
export APO_CLOUDFLARE_TUNNEL_TOKEN="public-docs-contract-token"
export APO_DOCS_HOST="docs.test-apo.online"

docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/docker-compose.cloudflare-tunnel.yml" \
  -f "$REPO_ROOT/docker-compose.cloudflare-tunnel.override.yml" \
  -f "$REPO_ROOT/docker-compose.public-docs.yml" \
  config --format json > "$RENDERED_CONFIG"

cd "$REPO_ROOT"
node tests/deployment/public-docs-contract.mjs "$RENDERED_CONFIG"
