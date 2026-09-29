import type { GenerationExecutionSummary } from "@/lib/agent-task-api";

interface RunVerdictFields {
  status: string;
  pass_result?: boolean | null;
  failed_checks?: number;
  errored_checks?: number;
  error_message?: string | null;
  generation_execution?: GenerationExecutionSummary | null;
}

/** The backend's no-verdict message starts with this (issue #323). */
const NO_VERDICT_MESSAGE_PREFIX = "No verdict: ";

/** Issue #149: most of the run's model generations ended in error. */
export function generationErrorsDominate(
  generations: GenerationExecutionSummary | null | undefined,
): boolean {
  return generations != null && generations.total > 0 && generations.errored * 2 > generations.total;
}

/**
 * An `error` run that has no verdict only because the judge gave none for its
 * non-passing checks (issue #323) — nothing genuinely failed. Mirrors the
 * backend's `is_judge_no_verdict_run`, which also keys on the rule's own
 * message: an executor-errored run can carry the same counts but never that
 * message. Such a run stays correctable, unlike an executor error or a
 * generation-dominated run (#149).
 */
export function isJudgeNoVerdictRun(run: RunVerdictFields): boolean {
  return (
    run.status === "error" &&
    run.pass_result == null &&
    (run.failed_checks ?? 0) === 0 &&
    (run.errored_checks ?? 0) > 0 &&
    (run.error_message ?? "").startsWith(NO_VERDICT_MESSAGE_PREFIX) &&
    !generationErrorsDominate(run.generation_execution)
  );
}

/** #149: the run's verdict was withheld because its generations mostly errored. */
export function isVerdictSuppressedByGenerations(run: RunVerdictFields): boolean {
  return (
    run.status === "error" &&
    run.pass_result == null &&
    generationErrorsDominate(run.generation_execution)
  );
}

/** The run's status label: "No verdict" for a judge no-verdict run, else `fallback`. */
export function runStatusLabel(run: RunVerdictFields, fallback: string): string {
  return isJudgeNoVerdictRun(run) ? "No verdict" : fallback;
}

/**
 * Whether a human correction can apply: a terminal verdict-bearing run, or a
 * judge no-verdict run — where the correction supplies the missing verdict.
 */
export function acceptsCorrections(run: RunVerdictFields): boolean {
  return (
    ((run.status === "passed" || run.status === "failed") && run.pass_result != null) ||
    isJudgeNoVerdictRun(run)
  );
}
