#!/usr/bin/env bash
# Anonymous public-docs smoke gate (SPEC-171 test 10).
#
# Probes the live docs origin from any external machine. Credential-free,
# safe to repeat, no state changes. Run only after DNS has propagated and the
# merged revision is deployed on the VPS.
#
# Usage: scripts/public-docs-smoke.sh https://docs.test-apo.online

set -euo pipefail

DOCS_URL="${1:-}"
if [[ -z "$DOCS_URL" ]]; then
  echo "usage: $0 https://docs.test-apo.online" >&2
  exit 2
fi
# Accept exactly one HTTPS origin (no path, query, credentials, or fragment).
if [[ ! "$DOCS_URL" =~ ^https://[^/]+$ ]]; then
  echo "error: expected exactly one HTTPS origin (e.g. https://docs.test-apo.online)" >&2
  exit 2
fi

TIMEOUT=15
PASS=0; FAIL=0

probe() {
  local method="$1" path="$2" expect="$3" description="$4"
  local status
  status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' \
    -X "$method" "$DOCS_URL$path" 2>/dev/null || echo "000")"
  if [[ "$status" == "$expect" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected $expect, got $status" >&2
    FAIL=$((FAIL + 1))
  fi
}

probe_type() {
  local path="$1" expect_ct="$2" expect_status="$3" description="$4"
  local ct status
  ct="$(curl -sS --max-time "$TIMEOUT" -D - -o /dev/null "$DOCS_URL$path" 2>/dev/null \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="content-type"{print $2}')"
  status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "$DOCS_URL$path" 2>/dev/null || echo "000")"
  if [[ "$status" == "$expect_status" ]] && [[ "$ct" == "$expect_ct"* ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected $expect_status + $expect_ct, got $status + ${ct:-none}" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "probing $DOCS_URL ..."

# --- Landing page + start.md (200, no auth) ---
probe      GET "/"                "200" "landing page reachable without auth"
probe_type "/start.md"            "text/markdown" "200" "start.md served as markdown"
probe_type "/reference/assertions.md" "text/markdown" "200" "generated reference markdown served"

# --- Schema $id URLs resolve to JSON ---
probe_type "/specs/contracts/task-revision/v1/manifest.schema.json" "application/json" "200" "manifest schema served as json"
probe_type "/specs/contracts/task-revision/v1/case.schema.json"     "application/json" "200" "case schema served as json"

# --- Unknown path → static 404 (never reaches app) ---
probe GET "/nonexistent-page-xyz" "404" "unknown path returns 404 from static docs"

# --- Application paths on the docs host must NOT reach the backend ---
probe      GET  "/backend-proxy/health/ready"              "404" "docs host must not reach backend readiness"
probe      POST "/api/public/otel/v1/traces"               "404" "docs host must not reach OTLP handler"

# --- No retired origin leaks into served content ---
if curl -sS --max-time "$TIMEOUT" "$DOCS_URL/start.md" 2>/dev/null | grep -q "apo.dev"; then
  echo "FAIL: served start.md still references the retired apo.dev origin" >&2
  FAIL=$((FAIL + 1))
else
  PASS=$((PASS + 1))
fi

# --- Result ---
echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "public docs smoke: FAIL ($PASS passed, $FAIL failed)"
  exit 1
fi
echo "public docs smoke: ok ($PASS probes passed)"
