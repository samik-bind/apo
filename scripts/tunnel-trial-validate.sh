#!/usr/bin/env bash
# SPEC-157: Tunnel Trial live validation orchestrator.
#
# Executes the full live-validation gate for a Cloudflare Tunnel Trial.
# Reads secrets only from protected files, never from argv. Produces a
# private sanitized report.
#
# Usage:
#   scripts/tunnel-trial-validate.sh \
#     --installation-env /path/to/apo.env \
#     --validation-env /path/to/tunnel-trial-validation.env \
#     [--agentcore-invoker /path/to/wrapper] \
#     [--restart]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT_DIR="${REPO_ROOT}/.personal/validation"
INSTALL_ENV=""
VALIDATION_ENV=""
AGENTCORE_INVOKER=""
RESTART=false

# --- Parse arguments (files only, never secrets) ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --installation-env) INSTALL_ENV="$2"; shift 2 ;;
    --validation-env) VALIDATION_ENV="$2"; shift 2 ;;
    --agentcore-invoker) AGENTCORE_INVOKER="$2"; shift 2 ;;
    --restart) RESTART=true; shift ;;
    *) echo "error: unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$INSTALL_ENV" ]] && { echo "error: --installation-env is required" >&2; exit 2; }
[[ -z "$VALIDATION_ENV" ]] && { echo "error: --validation-env is required" >&2; exit 2; }

# --- Preflight: validate protected files ---
_check_file() {
  local path="$1" label="$2"
  [[ -L "$path" ]] && { echo "error: $label is a symlink: $path" >&2; exit 1; }
  [[ -d "$path" ]] && { echo "error: $label is a directory" >&2; exit 1; }
  [[ ! -f "$path" ]] && { echo "error: $label not found: $path" >&2; exit 1; }
  local mode; mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null)"
  [[ "$mode" != "600" ]] && { echo "error: $label mode is $mode, expected 600" >&2; exit 1; }
}

_check_file "$INSTALL_ENV" "installation environment file"
_check_file "$VALIDATION_ENV" "validation environment file"

if [[ -n "$AGENTCORE_INVOKER" ]]; then
  [[ -L "$AGENTCORE_INVOKER" ]] && { echo "error: agentcore invoker is a symlink" >&2; exit 1; }
  [[ ! -x "$AGENTCORE_INVOKER" ]] && { echo "error: agentcore invoker is not executable" >&2; exit 1; }
fi

# --- Parse installation env (no eval/source) ---
parse_env() {
  local file="$1"
  declare -gA _ENV_VALUES=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    local key="${line%%=*}" val="${line#*=}"
    [[ "$key" == "$line" ]] && continue
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    _ENV_VALUES["$key"]="$val"
  done < "$file"
}

parse_env "$INSTALL_ENV"
PUBLIC_URL="${_ENV_VALUES[APO_PUBLIC_URL]:-}"
INGRESS_MODE="${_ENV_VALUES[APO_INGRESS_MODE]:-}"

[[ -z "$PUBLIC_URL" ]] && { echo "error: APO_PUBLIC_URL missing from installation env" >&2; exit 1; }
[[ "$INGRESS_MODE" != "cloudflare-tunnel" ]] && { echo "error: APO_INGRESS_MODE must be cloudflare-tunnel" >&2; exit 1; }

# Parse validation env for required keys (without printing values)
parse_env "$VALIDATION_ENV"
for required in APO_VALIDATION_PROJECT_ID APO_VALIDATION_ADMIN_EMAIL APO_VALIDATION_FULL_PUBLIC_KEY APO_VALIDATION_FULL_SECRET_KEY; do
  [[ -z "${_ENV_VALUES[$required]:-}" ]] && { echo "error: $required missing from validation env" >&2; exit 1; }
done

# --- Setup private temporary workspace ---
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

TIMESTAMP="$(date -u '+%Y%m%d-%H%M%S')"
REPORT_PATH="$REPORT_DIR/tunnel-trial-$TIMESTAMP.md"
mkdir -p "$REPORT_DIR"

# --- Initialize report ---
cat > "$REPORT_PATH" <<EOF
# Tunnel Trial Validation Report

- Timestamp: $TIMESTAMP UTC
- Ingress: $INGRESS_MODE
- Phases:
EOF

phase_result() {
  local phase="$1" result="$2" detail="$3"
  printf -- '- %s: %s%s\n' "$phase" "$result" "${detail:+ ($detail)}" >> "$REPORT_PATH"
}

# --- Phase 1: Anonymous public smoke ---
echo "Phase 1: Anonymous public smoke..."
if bash "$REPO_ROOT/scripts/public-ingress-smoke.sh" "$PUBLIC_URL" >/dev/null 2>&1; then
  phase_result "anonymous-smoke" "PASS" ""
  echo "  PASS"
else
  phase_result "anonymous-smoke" "FAIL" "see smoke output"
  echo "  FAIL"
fi

# --- Phase 2: Authenticated synthetic validation ---
echo "Phase 2: Authenticated synthetic OTLP..."
if [[ -f "$REPO_ROOT/tests/deployment/tunnel-trial-live.mjs" ]]; then
  # Export validation env vars for the Node helper (never in argv)
  export APO_VALIDATION_URL="$PUBLIC_URL"
  for key in APO_VALIDATION_PROJECT_ID APO_VALIDATION_ADMIN_EMAIL APO_VALIDATION_FULL_PUBLIC_KEY APO_VALIDATION_FULL_SECRET_KEY; do
    export "$key=${_ENV_VALUES[$key]}"
  done

  if node "$REPO_ROOT/tests/deployment/tunnel-trial-live.mjs" >> "$REPORT_PATH" 2>&1; then
    echo "  PASS"
  else
    echo "  FAIL (see report)"
  fi
else
  phase_result "synthetic-otlp" "BLOCKED" "Node helper not found"
  echo "  BLOCKED"
fi

# --- Phase 3: AgentCore (optional) ---
if [[ -n "$AGENTCORE_INVOKER" ]]; then
  echo "Phase 3: AgentCore invocation..."
  CANARY="spec157-$(openssl rand -hex 8)"
  if "$AGENTCORE_INVOKER" "$CANARY" >> "$REPORT_PATH" 2>&1; then
    phase_result "agentcore" "PASS" "canary=$CANARY"
    echo "  PASS"
  else
    phase_result "agentcore" "FAIL" "invoker exit non-zero"
    echo "  FAIL"
  fi
else
  phase_result "agentcore" "SKIPPED" "no invoker provided"
  echo "  SKIPPED"
fi

# --- Phase 4: Restart persistence (opt-in) ---
if $RESTART; then
  echo "Phase 4: Container restart persistence..."
  # Select the correct compose overlays from the installation env
  COMPOSE_FILES=(-f "$REPO_ROOT/docker-compose.yml")
  DB="${_ENV_VALUES[APO_DATABASE_PROFILE]:-sqlite}"
  [[ "$DB" == "postgres" ]] && COMPOSE_FILES+=(-f "$REPO_ROOT/docker-compose.postgres.yml")
  COMPOSE_FILES+=(-f "$REPO_ROOT/docker-compose.cloudflare-tunnel.yml")

  if docker compose --env-file "$INSTALL_ENV" "${COMPOSE_FILES[@]}" restart backend caddy cloudflared >> "$REPORT_PATH" 2>&1; then
    sleep 10
    if bash "$REPO_ROOT/scripts/public-ingress-smoke.sh" "$PUBLIC_URL" >/dev/null 2>&1; then
      phase_result "restart-persistence" "PASS" ""
      echo "  PASS"
    else
      phase_result "restart-persistence" "FAIL" "smoke failed after restart"
      echo "  FAIL"
    fi
  else
    phase_result "restart-persistence" "FAIL" "restart command failed"
    echo "  FAIL"
  fi
else
  phase_result "restart-persistence" "SKIPPED" "no --restart"
  echo "  SKIPPED (use --restart to enable)"
fi

# --- Result ---
echo ""
echo "validation complete. report: $REPORT_PATH"
echo "(report contains no secrets by construction)"
