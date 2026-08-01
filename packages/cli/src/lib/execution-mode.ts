/**
 * the dispatch decision is now caller-vs-unrecorded only.
 * Bundled/backend execution is retired; `execution:` and `default_execution`
 * are ignored.
 */
export type ExecutionMode = "local-recorded" | "local-unrecorded";

export type ExecutionReason = "default" | "no-project";

export type ExecutionModeResult = {
  mode: ExecutionMode;
  reason: ExecutionReason;
};

export type ExecutionModeInput = {
  hasProject: boolean;
};

export function resolveExecutionMode(input: ExecutionModeInput): ExecutionModeResult {
  if (input.hasProject) return { mode: "local-recorded", reason: "default" };
  return { mode: "local-unrecorded", reason: "no-project" };
}
