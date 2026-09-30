import type { GenerationExecutionSummary } from "@/lib/agent-task-api";
import { generationErrorsDominate, type GenerationNoticeVerdict } from "@/lib/run-verdict";

interface GenerationExecutionNoticeProps {
  execution: GenerationExecutionSummary | null;
  /** From `generationNoticeProps`. */
  verdict: GenerationNoticeVerdict;
}

function verdictSentence(
  verdict: GenerationNoticeVerdict,
  execution: GenerationExecutionSummary,
): string {
  switch (verdict) {
    case "withheld":
      return "APO recorded no PASS/FAIL verdict. The checks remain available as diagnostic evidence. ";
    case "kept":
      return "The run recovered and kept its verdict. ";
    case "judge-no-verdict":
      // The judge's missing verdicts, not these errors, left the run without one.
      return "Too few to withhold the verdict on their own. ";
    case "execution-error":
      return generationErrorsDominate(execution)
        ? "Most generations errored, and the run also ended in an execution error. "
        : "The run ended in an execution error. ";
  }
}

export default function GenerationExecutionNotice({
  execution,
  verdict,
}: GenerationExecutionNoticeProps) {
  if (!execution || execution.errored <= 0) return null;

  const reasons = Object.entries(execution.error_finish_reasons)
    .map(([reason, count]) => `${reason} ×${count}`)
    .join(", ");

  return (
    <div className="mx-6 mt-4 border border-warning/30 bg-warning/10 px-4 py-3 text-[13px] text-warning">
      <p className="font-medium">
        {execution.errored} of {execution.total} generations ended in error.
      </p>
      <p className="mt-1 text-warning/80">
        {verdictSentence(verdict, execution)}
        Cost and token totals are partial because errored generations are excluded.
      </p>
      {reasons && (
        <p className="mt-1 font-mono text-xs text-warning/80">
          Finish reasons: {reasons}
        </p>
      )}
    </div>
  );
}
