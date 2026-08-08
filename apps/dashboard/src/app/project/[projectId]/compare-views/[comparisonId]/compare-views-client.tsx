"use client";

// SPEC-174 comparison page — renders the SAME task-level comparison as
// /runs/compare (useComparison + FlowSection), fed by the resolved run_ids
// from the immutable view snapshot. The only structural difference is the
// header: view configs (Model · Effort · Date) instead of batch summaries.

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";

import type { AgentTaskRunSummary, AgentTaskSummary } from "@/lib/agent-task-api";
import type { TaskViewComparisonSnapshot, TaskViewConfig } from "@/lib/agent-task-view-api";
import { cn } from "@/lib/utils";
import { useUrlParamSet } from "@/hooks/use-url-state";

import { tallyChecks, useComparison, type CheckTally } from "../../runs/compare/use-comparison";
import { FlowSection } from "../../runs/compare/components/FlowSection";

export function CompareViewsClient({
  projectId,
  snapshot,
  tasks,
  leftRuns,
  rightRuns,
}: {
  projectId: string;
  snapshot: TaskViewComparisonSnapshot;
  tasks: AgentTaskSummary[];
  leftRuns: AgentTaskRunSummary[];
  rightRuns: AgentTaskRunSummary[];
}) {
  const [expanded, toggleExpanded] = useUrlParamSet("expand");
  const comparison = useComparison(leftRuns, rightRuns, tasks);

  // Same "hide identical" filter as /runs/compare: only show tasks that differ
  // or are one-sided (present in only one view).
  const foldersToShow = useMemo(() => {
    return comparison.folders.flatMap((f) => {
      const visibleTasks = f.tasks.filter((t) => t.differs || t.left.run === null || t.right.run === null);
      return visibleTasks.length > 0 ? [{ ...f, tasks: visibleTasks }] : [];
    });
  }, [comparison.folders]);

  const viewLabel = (v: TaskViewConfig) => {
    const parts = [v.model ?? "All models"];
    if (v.effort) parts.push(v.effort);
    if (v.since) parts.push(v.since);
    return parts.join(" · ");
  };

  return (
    <div className="mx-auto w-full max-w-6xl">
      {/* Breadcrumb */}
      <div className="border-b border-border bg-background">
        <div className="flex items-center gap-1.5 px-6 py-5 text-[12px] text-muted-foreground">
          <Link href={`/project/${projectId}/tasks`} className="inline-flex items-center gap-1 hover:text-foreground">
            <ArrowLeft className="h-3 w-3" /> Tasks
          </Link>
          <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          <span className="text-foreground">Compare views</span>
        </div>
      </div>

      {/* Header: both view configs + summary */}
      <div className="border-b border-border bg-background px-6 py-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ViewSlot label="View A" view={snapshot.view_a_config} accent="warning" />
          <ViewSlot label="View B" view={snapshot.view_b_config} accent="foreground" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
          {comparison.totalDiffers > 0 ? (
            <span>
              <span className="font-mono tabular-nums text-foreground">{comparison.totalDiffers}</span>{" "}
              of{" "}
              <span className="font-mono tabular-nums text-foreground">{comparison.tasks.length}</span>{" "}
              tasks differ
            </span>
          ) : (
            <span>No tasks differ between these views</span>
          )}
          {comparison.totalOnlyInOne > 0 && (
            <span className="text-muted-foreground/60">
              {" · "}
              <span className="font-mono tabular-nums">{comparison.totalOnlyInOne}</span> task{comparison.totalOnlyInOne > 1 ? "s" : ""} only in one view
            </span>
          )}
          {comparison.leftChecks.total > 0 && comparison.rightChecks.total > 0 && (
            <CheckDelta left={comparison.leftChecks} right={comparison.rightChecks} />
          )}
        </div>
      </div>

      {/* Task rows — same FlowSection rendering as /runs/compare */}
      {comparison.tasks.length === 0 ? (
        <div className="m-6 border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
          These views share no tasks — there is nothing to compare.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {foldersToShow.map((f) => (
            <FlowSection
              key={f.folder}
              folder={f.folder}
              tasks={f.tasks}
              differsCount={f.tasks.filter((t) => t.differs).length}
              leftChecks={tallyChecks(f.tasks.map((t) => t.left))}
              rightChecks={tallyChecks(f.tasks.map((t) => t.right))}
              defaultOpen={f.tasks.some((t) => t.differs)}
              expanded={expanded}
              onToggleExpand={toggleExpanded}
              projectId={projectId}
            />
          ))}
          {foldersToShow.length === 0 && (
            <div className="px-6 py-10 text-center text-[13px] text-muted-foreground">
              No differing tasks — all aligned tasks are identical.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ViewSlot({ label, view, accent }: { label: string; view: TaskViewConfig; accent: "warning" | "foreground" }) {
  const parts = [view.model ?? "All models"];
  if (view.effort) parts.push(view.effort);
  if (view.since) parts.push(view.since);
  return (
    <div className="border border-border bg-card/40 p-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "grid h-5 min-w-5 place-items-center px-1 font-mono text-[11px] font-semibold text-black",
            accent === "warning" ? "bg-warning" : "bg-foreground",
          )}
        >
          {label === "View A" ? "A" : "B"}
        </span>
        <span className="text-[12px] font-medium text-foreground/80">{label}</span>
      </div>
      <p className="mt-2 font-mono text-[13px] text-foreground">{parts.join(" · ")}</p>
    </div>
  );
}

function CheckDelta({ left, right }: { left: CheckTally; right: CheckTally }) {
  const delta = right.passed - left.passed;
  const sign = delta > 0 ? "+" : "";
  return (
    <span className="font-mono tabular-nums">
      <span className="text-muted-foreground/60">· checks </span>
      <span className="text-muted-foreground">{left.passed}/{left.total}</span>
      <span className="text-muted-foreground/40"> → </span>
      <span className="text-muted-foreground">{right.passed}/{right.total}</span>
      {delta !== 0 && (
        <span className={cn("ml-1", delta > 0 ? "text-success" : "text-destructive")}>
          ({sign}{delta})
        </span>
      )}
    </span>
  );
}
