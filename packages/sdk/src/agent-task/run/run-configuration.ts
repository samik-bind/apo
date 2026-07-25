import type { AgentTaskRunConfiguration } from "../adapter/types.ts";

/**
 * SPEC-148: validate and normalize an adapter-reported Run Configuration.
 *
 * Mirrors the backend validation contract so the SDK and the shared backend
 * finalizer enforce identical rules. Returns `undefined` when no configuration
 * was reported. An invalid configuration (blank model, oversized value, or a
 * NUL/control character) throws — it is an adapter contract error that must
 * fail the Task Run before the first Task Turn.
 *
 * Rules:
 *   - trim leading/trailing whitespace from `model` and `effort`;
 *   - `model` is required (1–255 UTF-8 bytes);
 *   - `effort` is optional; when present it is 1–64 UTF-8 bytes (an
 *     empty/whitespace effort normalizes to `undefined` = not reported);
 *   - reject NUL and ASCII control characters (checked before trimming, since
 *     some runtimes strip C0 controls as whitespace);
 *   - preserve casing and punctuation.
 *
 * Error messages name the field only — never echo secret-bearing source values.
 */
export function normalizeRunConfiguration(
  raw: AgentTaskRunConfiguration | undefined,
): AgentTaskRunConfiguration | undefined {
  if (!raw) return undefined;
  const model = normalizeScalar(raw.model, "run_configuration.model", MAX_MODEL_BYTES, true);
  const effort = normalizeScalar(
    raw.effort,
    "run_configuration.effort",
    MAX_EFFORT_BYTES,
    false,
  );
  return effort === undefined ? { model } : { model, effort };
}

const MAX_MODEL_BYTES = 255;
const MAX_EFFORT_BYTES = 64;
// NUL and ASCII control characters (C0 controls plus DEL).
// oxlint-disable-next-line no-control-regex -- intentional: these are the characters we reject.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

const utf8Encoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).length;
}

function normalizeScalar(
  value: string | undefined,
  field: string,
  maxBytes: number,
  required: true,
): string;
function normalizeScalar(
  value: string | undefined,
  field: string,
  maxBytes: number,
  required: false,
): string | undefined;
function normalizeScalar(
  value: string | undefined,
  field: string,
  maxBytes: number,
  required: boolean,
): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`${field} is required`);
    return undefined;
  }
  if (CONTROL_CHARS.test(value)) {
    throw new Error(`${field} must not contain control characters`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    if (required) throw new Error(`${field} is required and must be non-empty`);
    return undefined;
  }
  if (utf8ByteLength(trimmed) > maxBytes) {
    throw new Error(`${field} must be at most ${maxBytes} UTF-8 bytes`);
  }
  return trimmed;
}
