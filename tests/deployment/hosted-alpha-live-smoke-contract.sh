#!/usr/bin/env bash
# Fixture-backed contract for the hosted-alpha live-smoke preflight
#.
#
# 1. The preflight must FAIL (and name the application entrypoint) against a
#    fixture that answers /login with a Basic challenge.
# 2. The preflight must FAIL (and name the hosted-alpha documentation) when
#    app checks pass but /hosted-alpha/ returns 404.
# 3. The preflight must FAIL (naming the internal redirect, printing nothing
#    secret) when a public route redirects into the deployment interior.
# Plus: the healthy topology must PASS end to end.
#
# Run: bash tests/deployment/hosted-alpha-live-smoke-contract.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
FIXTURE_URL="http://127.0.0.1:${PORT}"
SMOKE="$REPO_ROOT/scripts/hosted-alpha-live-smoke.sh"

failures=0

start_fixture() {
  local mode="$1"
  node "$REPO_ROOT/tests/deployment/hosted-alpha-live-smoke-fixture.mjs" "$PORT" "$mode" &
  FIXTURE_PID=$!
  for _ in $(seq 1 50); do
    if curl -sS -o /dev/null --max-time 1 "$FIXTURE_URL/api/public/health" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  echo "FAIL: fixture ($mode) did not become ready" >&2
  return 1
}

stop_fixture() {
  kill "$FIXTURE_PID" 2>/dev/null || true
  wait "$FIXTURE_PID" 2>/dev/null || true
}

run_smoke() {
  # Both origins point at the fixture; the example link too, so the contract
  # never depends on the network.
  HOSTED_ALPHA_EXAMPLE_URL="$FIXTURE_URL/maintained-example" \
    "$SMOKE" "$FIXTURE_URL" "$FIXTURE_URL" "$@"
}

expect_smoke_failure() {
  local mode="$1" pattern="$2" outfile="$3"
  if run_smoke > "$outfile" 2>&1; then
    echo "FAIL: smoke accepted the $mode fixture (expected failure):" >&2
    cat "$outfile" >&2
    failures=$((failures + 1))
  elif grep -qi "$pattern" "$outfile"; then
    echo "smoke rejects $mode by name: ok"
  else
    echo "FAIL: smoke failed on $mode but did not identify it (wanted '$pattern'):" >&2
    cat "$outfile" >&2
    failures=$((failures + 1))
  fi
}

# --- Healthy topology must pass ---
start_fixture ok
trap stop_fixture EXIT
if run_smoke > /tmp/hosted-alpha-smoke-ok.out 2>&1; then
  echo "smoke accepts the healthy hosted alpha: ok"
else
  echo "FAIL: smoke rejected the healthy fixture (expected success):" >&2
  cat /tmp/hosted-alpha-smoke-ok.out >&2
  failures=$((failures + 1))
fi
stop_fixture
trap - EXIT

# --- Test 1: outer Basic Auth gate on the application entrypoint ---
start_fixture basic-gate
trap stop_fixture EXIT
expect_smoke_failure basic-gate "application entry" /tmp/hosted-alpha-smoke-basic.out
stop_fixture
trap - EXIT

# --- Test 2: stale hosted docs ---
start_fixture stale-docs
trap stop_fixture EXIT
expect_smoke_failure stale-docs "hosted-alpha documentation" /tmp/hosted-alpha-smoke-stale-docs.out
stop_fixture
trap - EXIT

# --- Test 3: internal redirect ---
start_fixture internal-redirect
trap stop_fixture EXIT
expect_smoke_failure internal-redirect "internal host" /tmp/hosted-alpha-smoke-redirect.out
stop_fixture
trap - EXIT

# --- Test 4: unavailable readiness ---
start_fixture unready
trap stop_fixture EXIT
expect_smoke_failure unready "readiness" /tmp/hosted-alpha-smoke-unready.out
stop_fixture
trap - EXIT

rm -f /tmp/hosted-alpha-smoke-ok.out /tmp/hosted-alpha-smoke-basic.out \
  /tmp/hosted-alpha-smoke-stale-docs.out /tmp/hosted-alpha-smoke-redirect.out \
  /tmp/hosted-alpha-smoke-unready.out

if [[ "$failures" -gt 0 ]]; then
  echo "hosted alpha live smoke contract: FAIL ($failures)"
  exit 1
fi
echo "hosted alpha live smoke contract: ok"
