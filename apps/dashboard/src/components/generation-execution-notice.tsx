import type { GenerationExecutionSummary } from "@/lib/agent-task-api";

interface GenerationExecutionNoticeProps {
  execution: GenerationExecutionSummary | null;
  verdictSuppressed: boolean;
}

export default function GenerationExecutionNotice({
  execution,
  verdictSuppressed,
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
        {verdictSuppressed
          ? "APO recorded no PASS/FAIL verdict. The checks remain available as diagnostic evidence. "
          : "The run recovered and kept its verdict. "}
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
