import type { GenerationExecutionSummary } from "@/lib/agent-task-api";

interface RunVerdictFields {
  status: string;
  pass_result?: boolean | null;
  failed_checks?: number;
  errored_checks?: number;
  generation_execution?: GenerationExecutionSummary | null;
}

/**
 * An `error` run that has no verdict only because the judge never answered
 * for its non-passing checks (issue #323) — nothing genuinely failed. Mirrors
 * the backend's `is_judge_no_verdict_run`: such a run stays correctable,
 * unlike an executor error or a generation-dominated run (#149).
 */
export function isJudgeNoVerdictRun(run: RunVerdictFields): boolean {
  const generations = run.generation_execution;
  const generationsDominate =
    generations != null && generations.total > 0 && generations.errored * 2 > generations.total;
  return (
    run.status === "error" &&
    run.pass_result == null &&
    (run.failed_checks ?? 0) === 0 &&
    (run.errored_checks ?? 0) > 0 &&
    !generationsDominate
  );
}
