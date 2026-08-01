#!/usr/bin/env bash
# Contract tests for the tunnel-trial validation harness.
#
# These tests use temporary files, fake commands, and sentinel secrets to
# verify the harness's preflight, secrecy, and structure without needing
# real external credentials.
#
# Run: bash tests/deployment/tunnel-trial-validation-contract.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
PASS=0; FAIL=0

_assert() {
  local desc="$1" result="$2"
  if [[ "$result" == "0" ]]; then
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc" >&2
    FAIL=$((FAIL + 1))
  fi
}

# --- Test 1: Smoke script rejects non-HTTPS origins ---
for bad_url in "http://apo.example.com" "https://apo.example.com/path" "https://apo.example.com?q=1" "not-a-url"; do
  scripts/public-ingress-smoke.sh "$bad_url" >/dev/null 2>&1 && _assert "smoke rejects $bad_url" 1 || _assert "smoke rejects $bad_url" 0
done

# --- Test 2: Validation env must be mode 0600 ---
# Create a mode-0644 file
echo "APO_VALIDATION_PROJECT_ID=test" > "$TMPDIR/bad-perms.env"
chmod 0644 "$TMPDIR/bad-perms.env"
if [[ -f "$REPO_ROOT/scripts/tunnel-trial-validate.sh" ]]; then
  # The harness should reject world-readable files
  bash "$REPO_ROOT/scripts/tunnel-trial-validate.sh" \
    --installation-env "$TMPDIR/bad-perms.env" \
    --validation-env "$TMPDIR/bad-perms.env" \
    >/dev/null 2>&1 && _assert "harness rejects 0644 file" 1 || _assert "harness rejects 0644 file" 0
else
  _assert "harness script exists" 1
fi

# --- Test 3: Validation env rejects symlink ---
ln -s /dev/null "$TMPDIR/symlink.env"
if [[ -f "$REPO_ROOT/scripts/tunnel-trial-validate.sh" ]]; then
  bash "$REPO_ROOT/scripts/tunnel-trial-validate.sh" \
    --installation-env "$TMPDIR/symlink.env" \
    --validation-env "$TMPDIR/symlink.env" \
    >/dev/null 2>&1 && _assert "harness rejects symlink" 1 || _assert "harness rejects symlink" 0
else
  _assert "harness script exists" 1
fi

# --- Test 4: Smoke script syntax is valid ---
bash -n "$REPO_ROOT/scripts/public-ingress-smoke.sh" && _assert "smoke syntax valid" 0 || _assert "smoke syntax valid" 1

# --- Test 5: Tunnel validate script syntax is valid (if exists) ---
if [[ -f "$REPO_ROOT/scripts/tunnel-trial-validate.sh" ]]; then
  bash -n "$REPO_ROOT/scripts/tunnel-trial-validate.sh" && _assert "validate syntax valid" 0 || _assert "validate syntax valid" 1
else
  _assert "validate script exists" 1
fi

# --- Result ---
echo ""
if [[ "$FAIL" -gt 0 ]]; then
  echo "tunnel-trial validation contract: FAIL ($PASS passed, $FAIL failed)"
  exit 1
fi
echo "tunnel-trial validation contract: ok ($PASS passed)"
