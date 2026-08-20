#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RENDERED_CONFIG_DISABLED="$(mktemp)"
RENDERED_CONFIG_CONFIGURED="$(mktemp)"
RENDERED_CONFIG_TUNNEL="$(mktemp)"
trap 'rm -f "$RENDERED_CONFIG_DISABLED" "$RENDERED_CONFIG_CONFIGURED" "$RENDERED_CONFIG_TUNNEL"' EXIT

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

# Tunnel variants render with the locally-managed override so the rendered
# caddy service includes every volume both tunnel files contribute.
export APO_PUBLIC_URL="https://apo.example.com"
export CLOUDFLARED_CREDENTIALS_JSON="$REPO_ROOT/.cloudflared/credentials.json"
docker compose \
  -f "$REPO_ROOT/docker-compose.yml" \
  -f "$REPO_ROOT/docker-compose.cloudflare-tunnel.yml" \
  -f "$REPO_ROOT/docker-compose.cloudflare-tunnel.override.yml" \
  config --format json > "$RENDERED_CONFIG_TUNNEL"

cd "$REPO_ROOT"
node tests/deployment/public-ingress-contract.mjs \
  "$RENDERED_CONFIG_DISABLED" \
  "$RENDERED_CONFIG_CONFIGURED" \
  "$RENDERED_CONFIG_TUNNEL"
