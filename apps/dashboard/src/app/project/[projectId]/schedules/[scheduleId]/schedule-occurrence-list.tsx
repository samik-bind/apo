import Link from "next/link";
import type {
  OccurrenceMissedReason,
  ScheduleOccurrenceSummary,
} from "@/lib/agent-task-api";
import { useProjectId } from "@/lib/project-router";

interface ScheduleOccurrenceListProps {
  occurrences: ScheduleOccurrenceSummary[];
}

/** SPEC-163: honest Occurrence history. A missed Occurrence is never shown as
 * a failed Task result — it is availability/cadence information. Links appear
 * only when a Batch exists. */
export function ScheduleOccurrenceList({ occurrences }: ScheduleOccurrenceListProps) {
  const projectId = useProjectId();
  if (occurrences.length === 0) {
    return (
      <p className="px-6 py-4 text-[12px] text-muted-foreground">
        No occurrences yet.
      </p>
    );
  }
  return (
    <ol className="divide-y divide-border border-y border-border">
      {occurrences.map((occ) => {
        const copy = occurrenceCopy(occ);
        return (
          <li key={occ.id} className="flex items-center justify-between gap-3 px-6 py-2.5">
            <div className="min-w-0">
              <p className="text-[12px] text-foreground/80">{copy.label}</p>
              {copy.detail && (
                <p className="text-[11px] text-muted-foreground">{copy.detail}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
              <span>{formatScheduledFor(occ.scheduled_for)}</span>
              {occ.batch_run_id && (
                <Link
                  href={`/project/${projectId}/runs/${occ.batch_run_id}`}
                  className="font-mono text-foreground/70 hover:text-foreground hover:underline"
                >
                  view run
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function occurrenceCopy(
  occ: ScheduleOccurrenceSummary,
): { label: string; detail: string | null } {
  if (occ.status === "pending") {
    return { label: "Queued — waiting to start", detail: null };
  }
  if (occ.status === "delivered") {
    return { label: "Delivered", detail: "Ran in the owner’s connected environment." };
  }
  if (occ.status === "cancelled") {
    return { label: "Cancelled", detail: "Paused before any Task started." };
  }
  return { label: "Missed", detail: missedReasonDetail(occ.missed_reason) };
}

function missedReasonDetail(reason: OccurrenceMissedReason | null): string {
  switch (reason) {
    case "previous_occurrence_active":
      return "The previous occurrence was still active.";
    case "executor_unavailable":
      return "No compatible Connected Executor became available within 24 hours.";
    case "catalog_changed":
      return "Selected Tasks changed; review this Schedule.";
    case "selection_empty":
      return "This selection currently contains no Tasks.";
    default:
      return "No Batch was created for this due time.";
  }
}

function formatScheduledFor(value: string): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
