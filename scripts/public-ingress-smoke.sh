#!/usr/bin/env bash
# SPEC-157: Anonymous public-ingress smoke probe.
#
# Probes the final SPEC-153/155 route matrix from any external machine.
# Credential-free, safe to repeat, no state changes.
#
# Usage: scripts/public-ingress-smoke.sh https://apo.example.com

set -euo pipefail

PUBLIC_URL="${1:-}"
if [[ -z "$PUBLIC_URL" ]]; then
  echo "usage: $0 https://apo.example.com" >&2
  exit 2
fi
# Accept exactly one HTTPS origin (no path, query, credentials, or fragment).
if [[ ! "$PUBLIC_URL" =~ ^https://[^/]+$ ]]; then
  echo "error: expected exactly one HTTPS origin (e.g. https://apo.example.com)" >&2
  exit 2
fi

TIMEOUT=15
PASS=0; FAIL=0

probe() {
  local method="$1" path="$2" expect="$3" description="$4"
  local status
  status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' \
    -X "$method" "$PUBLIC_URL$path" 2>/dev/null || echo "000")"
  if [[ "$status" == "$expect" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected $expect, got $status" >&2
    FAIL=$((FAIL + 1))
  fi
}

# Like probe, but also accepts 307/401 — auth middleware may intercept
# removed routes before FastAPI's 404.
probe_auth_blocked() {
  local method="$1" path="$2" expect="$3" description="$4"
  local status
  status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' \
    -X "$method" "$PUBLIC_URL$path" 2>/dev/null || echo "000")"
  if [[ "$status" == "$expect" ]] || [[ "$status" == "307" ]] || [[ "$status" == "401" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected $expect/307/401, got $status" >&2
    FAIL=$((FAIL + 1))
  fi
}

probe_json() {
  local method="$1" path="$2" content_type="$3" data="$4" expect="$5" description="$6"
  local status
  status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' \
    -X "$method" -H "Content-Type: $content_type" -d "$data" \
    "$PUBLIC_URL$path" 2>/dev/null || echo "000")"
  if [[ "$status" == "$expect" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $description — expected $expect, got $status" >&2
    FAIL=$((FAIL + 1))
  fi
}

echo "probing $PUBLIC_URL ..."

# --- Dashboard reachable (200 or 307 redirect to login) ---
dash_status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "$PUBLIC_URL/" 2>/dev/null || echo "000")"
if [[ "$dash_status" == "200" ]] || [[ "$dash_status" == "307" ]]; then
  PASS=$((PASS + 1))
else
  echo "FAIL: dashboard reachable — expected 200/307, got $dash_status" >&2
  FAIL=$((FAIL + 1))
fi

# --- Public readiness (detail-free) ---
readiness_body="$(curl -sS --max-time "$TIMEOUT" "$PUBLIC_URL/api/public/health" 2>/dev/null || echo "")"
readiness_status="$(curl -sS --max-time "$TIMEOUT" -o /dev/null -w '%{http_code}' "$PUBLIC_URL/api/public/health" 2>/dev/null || echo "000")"
if [[ "$readiness_status" == "200" ]]; then
  if echo "$readiness_body" | grep -q '"status":"ready"'; then
    # Verify no extra fields disclosed.
    if echo "$readiness_body" | python3 -c "
import sys, json
d = json.load(sys.stdin)
keys = set(d.keys())
exit(0 if keys == {'status'} else 1)
" 2>/dev/null; then
      PASS=$((PASS + 1))
    else
      echo "FAIL: readiness body has extra fields" >&2
      FAIL=$((FAIL + 1))
    fi
  else
    echo "FAIL: readiness body is not {\"status\":\"ready\"}" >&2
    FAIL=$((FAIL + 1))
  fi
else
  echo "FAIL: public readiness expected 200, got $readiness_status" >&2
  FAIL=$((FAIL + 1))
fi

# --- OTLP requires auth (generic 401, no redirect/HTML) ---
probe_json POST "/api/public/otel/v1/traces" "application/json" "{}" "401" "unauthenticated OTLP returns 401"

# --- Private diagnostics denied (404 from Caddy, or 307/401 from auth) ---
probe_auth_blocked GET "/backend-proxy/health/ready" "404" "detailed readiness denied"
probe_auth_blocked GET "/api/health/ready" "404" "raw health/ready denied"
probe_auth_blocked GET "/backend-proxy/docs" "404" "Swagger docs denied"
probe_auth_blocked GET "/backend-proxy/openapi.json" "404" "OpenAPI spec denied"
probe_auth_blocked GET "/backend-proxy/hello" "404" "dev hello route denied"

# --- Legacy anonymous sharing removed (SPEC-155) ---
probe_auth_blocked GET "/public/traces/spec-157-canary" "404" "anonymous trace route removed"
probe_auth_blocked PATCH "/v1/runs/spec-157-canary/visibility" "404" "visibility toggle removed"

# --- Security headers on dashboard ---
dash_headers="$(curl -sS --max-time "$TIMEOUT" -D - -o /dev/null "$PUBLIC_URL/" 2>/dev/null || echo "")"
if echo "$dash_headers" | grep -qi "strict-transport-security"; then
  PASS=$((PASS + 1))
else
  echo "WARN: Strict-Transport-Security header not found (may be Cloudflare-managed)" >&2
fi

# --- Result ---
echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "public ingress: FAIL ($PASS passed, $FAIL failed)"
  exit 1
fi
echo "public ingress: ok ($PASS probes passed)"
echo "  dashboard: $PUBLIC_URL/"
echo "  health:    $PUBLIC_URL/api/public/health"
echo "  OTLP:      $PUBLIC_URL/api/public/otel/v1/traces"
