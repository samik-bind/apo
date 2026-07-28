import { Clock, Cpu, Server } from "lucide-react";
import type { ExecutionAttemptSummary } from "@/lib/agent-task-api";

interface ExecutionAttemptPanelProps {
  attempts: ExecutionAttemptSummary[];
  poolName: string | null;
}

export function ExecutionAttemptPanel({
  attempts,
  poolName,
}: ExecutionAttemptPanelProps) {
  if (attempts.length === 0) return null;

  const visibleAttempts = attempts.toSorted(
    (left, right) =>
      new Date(right.queued_at).getTime() - new Date(left.queued_at).getTime(),
  );

  return (
    <section className="border-t border-border px-6 py-4" aria-labelledby="execution-attempts-heading">
      <div className="mb-3 flex items-center gap-2">
        <Server className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 id="execution-attempts-heading" className="text-[12px] font-medium uppercase tracking-wider">
          Execution
        </h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {visibleAttempts.length} attempt{visibleAttempts.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="divide-y divide-border border border-border">
        {visibleAttempts.map((attempt) => {
          const presentation = describeAttempt(attempt, poolName);
          return (
            <div key={attempt.id} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[1fr_auto]">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px]">
                  <span className={`h-1.5 w-1.5 rounded-full ${presentation.dot}`} aria-hidden />
                  <span className="font-medium">{presentation.title}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {attempt.task_run_id.slice(0, 8)}
                  </span>
                </div>
                <p className="mt-1 text-[12px] text-muted-foreground">{presentation.detail}</p>
                {attempt.error_message && (
                  <p className="mt-1 line-clamp-2 text-[11px] text-destructive">
                    {attempt.error_message}
                  </p>
                )}
              </div>
              <div className="flex items-start gap-3 text-[11px] text-muted-foreground">
                {attempt.driver_kind && (
                  <span className="inline-flex items-center gap-1">
                    <Cpu className="h-3 w-3" />
                    {attempt.driver_kind}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 font-mono">
                  <Clock className="h-3 w-3" />
                  {formatAttemptTime(attempt)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function describeAttempt(
  attempt: ExecutionAttemptSummary,
  poolName: string | null,
): { title: string; detail: string; dot: string } {
  const pool = poolName ?? "configured pool";
  if (attempt.status === "queued") {
    return {
      title: `Waiting for ${pool}`,
      detail: `Queued ${formatAge(attempt.queued_at)}. Apo will not move this run to another pool.`,
      dot: "bg-muted-foreground animate-pulse",
    };
  }
  if (attempt.status === "leased") {
    return {
      title: "Executor claimed this task",
      detail: `${attempt.executor_name ?? "Executor"} is preparing the task.`,
      dot: "bg-foreground animate-pulse",
    };
  }
  if (attempt.status === "running") {
    const phase = attempt.phase ? attempt.phase.replaceAll("_", " ") : "running";
    return {
      title: `Running on ${attempt.executor_name ?? "executor"}`,
      detail: `Phase: ${phase}. Last heartbeat ${formatAge(attempt.heartbeat_at)}.`,
      dot: "bg-foreground animate-pulse",
    };
  }
  if (attempt.status === "lost") {
    return {
      title: "Executor connection lost",
      detail: "Execution may have continued remotely, so Apo cannot safely infer a result.",
      dot: "bg-warning",
    };
  }
  if (attempt.status === "cancelled") {
    return {
      title: "Execution cancelled",
      detail: "Apo stopped tracking this attempt as active.",
      dot: "bg-muted-foreground",
    };
  }
  if (attempt.status === "failed") {
    return failurePresentation(attempt.failure_kind, pool);
  }
  return {
    title: attempt.status.replaceAll("_", " "),
    detail: attempt.executor_name ? `Executor: ${attempt.executor_name}` : "Execution attempt finished.",
    dot: attempt.status === "succeeded" ? "bg-success" : "bg-muted-foreground",
  };
}

function failurePresentation(
  failureKind: string | null,
  poolName: string,
): { title: string; detail: string; dot: string } {
  const failures: Record<string, [string, string]> = {
    executor_unavailable: [
      "Executor unavailable",
      `${poolName} did not become available before the queue timeout.`,
    ],
    dependency_install_failed: [
      "Dependency setup failed",
      "The executor could not prepare the task dependencies.",
    ],
    runtime_error: ["Runtime failed", "The task process exited with a runtime error."],
    result_invalid: [
      "Task produced no result",
      "The task exited without writing a valid result file — usually a crash before completion. See the run logs for the error.",
    ],
    timeout: ["Execution timed out", "The task exceeded its configured execution limit."],
    cancelled: ["Execution cancelled", "The attempt was cancelled before completion."],
  };
  const [title, detail] = failures[failureKind ?? ""] ?? [
    "Execution failed",
    failureKind ? failureKind.replaceAll("_", " ") : "The executor reported a failure.",
  ];
  return { title, detail, dot: "bg-destructive" };
}

function formatAttemptTime(attempt: ExecutionAttemptSummary): string {
  const value =
    attempt.completed_at ??
    attempt.heartbeat_at ??
    attempt.started_at ??
    attempt.claimed_at ??
    attempt.queued_at;
  return new Date(value).toISOString().slice(11, 19);
}

function formatAge(value: string | null): string {
  if (!value) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
