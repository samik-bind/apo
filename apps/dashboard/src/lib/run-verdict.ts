import type { GenerationExecutionSummary, NoVerdictReason } from "@/lib/agent-task-api";

interface RunVerdictFields {
  status: string;
  pass_result?: boolean | null;
  /** Why an `error` run has no verdict; absent on backends that predate it. */
  no_verdict_reason?: NoVerdictReason | null;
  failed_checks?: number;
  errored_checks?: number;
  error_message?: string | null;
  generation_execution?: GenerationExecutionSummary | null;
}

/** Fallback only: the rule's message on a backend without `no_verdict_reason`. */
const NO_VERDICT_MESSAGE_PREFIX = "No verdict: ";

/** Issue #149: most of the run's model generations ended in error. */
export function generationErrorsDominate(
  generations: GenerationExecutionSummary | null | undefined,
): boolean {
  return generations != null && generations.total > 0 && generations.errored * 2 > generations.total;
}

/**
 * An `error` run that has no verdict only because the judge gave none for its
 * non-passing checks (issue #323) — nothing genuinely failed. Read from the
 * backend's structured `no_verdict_reason`, like its `is_judge_no_verdict_run`:
 * an executor error (#13) or a generation-dominated run (#149) carries its
 * own reason. Such a run stays correctable. Only a backend that predates the
 * field is recognised by the rule's message and counts instead.
 */
export function isJudgeNoVerdictRun(run: RunVerdictFields): boolean {
  if (run.status !== "error" || run.pass_result != null) return false;
  if (run.no_verdict_reason !== undefined) return run.no_verdict_reason === "judge";
  return (
    (run.failed_checks ?? 0) === 0 &&
    (run.errored_checks ?? 0) > 0 &&
    (run.error_message ?? "").startsWith(NO_VERDICT_MESSAGE_PREFIX) &&
    !generationErrorsDominate(run.generation_execution)
  );
}

/** #149: the run's verdict was withheld because its generations mostly errored. */
export function isVerdictSuppressedByGenerations(run: RunVerdictFields): boolean {
  if (run.status !== "error" || run.pass_result != null) return false;
  if (run.no_verdict_reason !== undefined) return run.no_verdict_reason === "generations";
  return generationErrorsDominate(run.generation_execution);
}

/**
 * How a run's `error_message` reads: a judge no-verdict's rule is a
 * `warning`; a passed run keeps an executor's note through a human PASS
 * correction, which is a `note`, not an error; anything else is an `error`.
 */
export function errorMessageTone(run: RunVerdictFields): "note" | "warning" | "error" {
  if (run.pass_result === true) return "note";
  return isJudgeNoVerdictRun(run) ? "warning" : "error";
}

const MESSAGE_TEXT_CLASS = {
  note: "text-muted-foreground",
  warning: "text-warning",
  error: "text-destructive",
} as const;

/** The text colour of a run's `error_message` in run rows. */
export function errorMessageTextClass(run: RunVerdictFields): string {
  return MESSAGE_TEXT_CLASS[errorMessageTone(run)];
}

/** What the generation notice says about the run's verdict (#149, #323). */
export type GenerationNoticeVerdict = "withheld" | "kept" | "judge-no-verdict" | "execution-error";

/** The generation notice's props for a run — derived here, not in the page. */
export function generationNoticeProps(
  run: RunVerdictFields,
): { execution: GenerationExecutionSummary | null; verdict: GenerationNoticeVerdict } {
  const verdict: GenerationNoticeVerdict = isVerdictSuppressedByGenerations(run)
    ? "withheld"
    : run.pass_result != null
      ? "kept"
      : isJudgeNoVerdictRun(run)
        ? "judge-no-verdict"
        : "execution-error";
  return { execution: run.generation_execution ?? null, verdict };
}

/**
 * Whether the run page shows the `error_message` banner. A #149 run's
 * message is carried by the generation notice instead; every other message —
 * an executor's, a judge no-verdict's — gets the banner.
 */
export function showsErrorBanner(run: RunVerdictFields): boolean {
  return Boolean(run.error_message) && !isVerdictSuppressedByGenerations(run);
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
