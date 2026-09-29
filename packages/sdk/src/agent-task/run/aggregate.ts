import type { EvaluationItemResult, TaskEvaluationResult } from "./types.ts";

/**
 * Issue #8: shown when a run ends with zero registered checks. A bare
 * `FAIL <task>` with no Checks section looked like a real failure but was
 * almost always a silent registration bug (e.g. a double-import that wiped
 * the check registry). Naming `test()` matches the documented registration
 * function — `apps/docs` reference/task.md.
 *
 * Lives next to {@link aggregateResult} because the empty-checks verdict is
 * the single source of truth for "why did this run fail with no checks?".
 * The CLI and the standalone e2e runner both import this so the wording
 * stays in one place.
 */
export const NO_CHECKS_REGISTERED_MESSAGE =
  "No tests were registered by the eval module — a task must define at least one test().";

export function aggregateResult(
  checksResults: EvaluationItemResult[],
): TaskEvaluationResult {
  if (checksResults.length === 0) {
    return { checks: checksResults, pass: false };
  }
  const pass = checksResults.every((r) => r.pass);
  return isNoVerdict(checksResults)
    ? { checks: checksResults, pass, noVerdict: true }
    : { checks: checksResults, pass };
}

/**
 * Issue #323: the run-level no-verdict rule — at least one check failed and
 * every failing check got no answer from the judge (`outcome: "error"`). An
 * `"unsupported"` check or a genuine fail keeps the FAIL verdict. The backend
 * applies the same rule to the recorded counts (`judge_no_verdict_message`).
 */
export function isNoVerdict(checksResults: EvaluationItemResult[]): boolean {
  const failing = checksResults.filter((r) => !r.pass);
  return failing.length > 0 && failing.every((r) => r.outcome === "error");
}
