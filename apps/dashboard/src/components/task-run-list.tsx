"use client";

import Link from "next/link";
import { ArrowUpRight, Clock, DollarSign, GitCompare, Hash } from "lucide-react";
import { type AgentTaskRunSummary } from "@/lib/agent-task-api";
import { TraceHomeLink } from "@/components/trace-detail";
import { TriggerBadge } from "@/components/trigger-badge";
import { cn } from "@/lib/utils";
import { formatCostMicro, formatTokenTotal } from "@/lib/format";
import { formatRunExecution, formatRunExecutionFull } from "@/lib/run-configuration";
import {
  TASK_RUN_STATUS,
  type TaskRunStatus,
  formatTaskRunDuration,
  formatTaskRunRelativeTime,
} from "./task-run-list.utils";

// Column layout shared by the header and every row — keep both in sync.
// The full 6-column table needs ~800px of content width, which next to the
// sidebar only exists from xl (1280px) up. Below that, columns that don't
// fit fold into the row's meta line instead of crushing the task name.
//   <lg  stacked rows — trigger/batch/execution in the meta line, stats wrap
//   lg   name · judges · duration · started
//   xl   name · trigger/batch · execution · judges · duration · started
const ROW_GRID_LG = "lg:grid-cols-[minmax(0,2fr)_minmax(8rem,1fr)_auto_auto]";
const ROW_GRID_XL = "xl:grid-cols-[minmax(0,2fr)_minmax(8rem,1.25fr)_minmax(7rem,1fr)_auto_auto_auto]";

function TaskRunPassBar({ value, muted }: { value: number; muted?: boolean }) {
  if (muted) return <span className="font-mono text-[12px] text-muted-foreground">&mdash;</span>;
  const color = value >= 80 ? "bg-success" : value < 50 ? "bg-destructive" : "bg-foreground/30";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-12 overflow-hidden rounded-full bg-border">
        <div className={cn("h-full", color)} style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-[12px] tabular-nums text-muted-foreground">{value}%</span>
    </div>
  );
}

/** Judge counts in the three states (running / no verdict yet / final). */
function JudgesCounts({ run }: { run: AgentTaskRunSummary }) {
  const isRunning = run.status === "running";
  const isInactive = run.status === "pending" || run.status === "error";
  if (isRunning) {
    return (
      <span className="font-mono tabular-nums text-muted-foreground">
        {run.passed_checks}/{run.total_checks}
      </span>
    );
  }
  if (isInactive || run.total_checks === 0) {
    return <span className="font-mono text-muted-foreground">&mdash;</span>;
  }
  return (
    <span className="inline-flex items-center font-mono tabular-nums">
      <span className="text-success">{run.passed_checks}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-destructive">{run.failed_checks}</span>
      <span className="text-muted-foreground">/</span>
      <span className="text-muted-foreground">{run.total_checks}</span>
    </span>
  );
}

function RunDuration({ run }: { run: AgentTaskRunSummary }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[13px] tabular-nums text-foreground">
      <Clock className="h-3 w-3 text-muted-foreground" />
      {formatTaskRunDuration(run.started_at, run.completed_at)}
    </span>
  );
}

function RunCost({ run }: { run: AgentTaskRunSummary }) {
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] tabular-nums text-muted-foreground">
      <DollarSign className="h-3 w-3 text-muted-foreground" />
      {run.total_cost != null && run.total_cost > 0 ? formatCostMicro(run.total_cost) : "\u2014"}
    </span>
  );
}

function RunTokens({ run }: { run: AgentTaskRunSummary }) {
  if (run.total_tokens == null || run.total_tokens <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1 font-mono text-[12px] tabular-nums text-muted-foreground">
      <Hash className="h-3 w-3 text-muted-foreground" />
      {formatTokenTotal(run.total_tokens)}
    </span>
  );
}

export function TaskRunRow({
  run,
  projectId,
  compareSelected = false,
  compareDisabled = false,
  onToggleCompare,
}: {
  run: AgentTaskRunSummary;
  projectId: string;
  /** Optional compare toggle (task page). When omitted, no compare button renders. */
  compareSelected?: boolean;
  compareDisabled?: boolean;
  onToggleCompare?: () => void;
}) {
  const status = (run.status in TASK_RUN_STATUS ? run.status : "pending") as TaskRunStatus;
  const statusConfig = TASK_RUN_STATUS[status];
  const isDone = status === "passed" || status === "failed";
  const passRate = run.total_checks > 0 ? Math.round((run.passed_checks / run.total_checks) * 100) : 0;
  const href = `/project/${projectId}/runs/task/${run.id}`;
  const hasCompare = typeof onToggleCompare === "function";

  return (
    <Link
      href={href}
      className="group block w-full px-6 py-3 text-left transition-colors hover:bg-card/60"
      onClick={(event) => {
        if (shouldIgnoreTaskRunNavigation(event.target)) {
          event.preventDefault();
        }
      }}
    >
      <div
        className={cn(
          "flex flex-col gap-2.5 lg:grid lg:items-center lg:gap-6",
          ROW_GRID_LG,
          ROW_GRID_XL,
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", statusConfig.dot)} aria-hidden />
            <span className="truncate text-[14px] font-medium text-foreground">{run.task_id}</span>
            <span className={cn("shrink-0 text-[11px] font-medium uppercase tracking-wide", statusConfig.text)}>
              {statusConfig.label}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
            <span className="font-mono text-muted-foreground">{run.id.slice(0, 10)}</span>
            <span className="text-muted-foreground">&middot;</span>
            <span className="font-mono text-muted-foreground">{run.task_path.split("/").slice(-2).join("/")}</span>
            {run.status === "running" && run.trace_run_id && (
              <>
                <span className="text-muted-foreground">&middot;</span>
                <TraceHomeLink
                  traceId={run.trace_run_id}
                  label="Trace home"
                  appearance="inline"
                  onClick={(e) => e.stopPropagation()}
                />
              </>
            )}
            {run.error_message && (
              <>
                <span className="text-muted-foreground">&middot;</span>
                <span className="block max-w-[200px] truncate whitespace-nowrap text-ellipsis text-destructive">
                  {run.error_message.slice(0, 80)}
                </span>
              </>
            )}
          </div>
          {/* Trigger/batch/execution fold into the meta line below xl, where
              their table columns don't fit next to the sidebar. */}
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 xl:hidden">
            <TriggerBadge trigger={run.trigger} />
            <span className="font-mono text-muted-foreground">{run.batch_run_id.slice(0, 8)}</span>
            {run.run_configuration && (
              <span
                className="min-w-0 truncate font-mono text-muted-foreground"
                title={formatRunExecutionFull(run.run_configuration)}
              >
                {formatRunExecution(run.run_configuration)}
              </span>
            )}
          </div>
        </div>

        {/* Trigger · Batch — own column only at xl */}
        <div className="hidden min-w-0 xl:block">
          <div className="flex min-w-0 items-center gap-2">
            <TriggerBadge trigger={run.trigger} />
            <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{run.batch_run_id.slice(0, 8)}</span>
          </div>
        </div>

        {/* Execution — model · effort in its own column (not crammed
            into the name meta line). Full qualified name on hover. */}
        <div className="hidden min-w-0 xl:block">
          <span
            className="block truncate font-mono text-[12px] tabular-nums text-muted-foreground"
            title={formatRunExecutionFull(run.run_configuration)}
          >
            {run.run_configuration ? formatRunExecution(run.run_configuration) : "\u2014"}
          </span>
        </div>

        {/* Judges — column from lg up; wrapped stat below lg */}
        <div className="hidden w-32 text-right lg:block">
          <JudgesCounts run={run} />
          <div className="mt-1 flex justify-end">
            <div className="w-24">
              <TaskRunPassBar value={passRate} muted={!isDone} />
            </div>
          </div>
        </div>

        {/* Duration · Cost · Tokens — column from lg up; wrapped stat below lg */}
        <div className="hidden w-28 text-right lg:block">
          <RunDuration run={run} />
          <div className="mt-1 flex justify-end"><RunCost run={run} /></div>
          <div className="mt-1 flex justify-end"><RunTokens run={run} /></div>
        </div>

        {/* Stats wrap — replaces the judges/duration columns below lg */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 lg:hidden">
          <JudgesCounts run={run} />
          <TaskRunPassBar value={passRate} muted={!isDone} />
          <RunDuration run={run} />
          <RunCost run={run} />
          <RunTokens run={run} />
        </div>

        <div className="flex items-center justify-end gap-2 lg:w-36">
          <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
            {formatTaskRunRelativeTime(run.started_at)}
          </span>
          {hasCompare && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleCompare?.();
              }}
              disabled={compareDisabled}
              aria-pressed={compareSelected}
              aria-label={compareSelected ? "Remove from comparison" : "Add to comparison"}
              title={compareDisabled ? "Clear a selection to compare this run" : compareSelected ? "Selected for comparison" : "Compare this run"}
              className={cn(
                "grid h-6 w-6 place-items-center rounded border transition-colors",
                compareSelected
                  ? "border-foreground bg-foreground text-background"
                  : compareDisabled
                    ? "cursor-not-allowed border-border text-muted-foreground/30"
                    : "border-border text-muted-foreground hover:border-foreground/50 hover:text-foreground",
              )}
            >
              <GitCompare className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="opacity-0 transition-opacity group-hover:opacity-100">
            <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        </div>
      </div>
    </Link>
  );
}

export function TaskRunListHeader({ withCompare = false }: { withCompare?: boolean }) {
  return (
    <div className="sticky top-0 z-10 hidden border-b border-border bg-background/95 px-6 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur lg:block">
      <div className={cn("grid items-center gap-6", ROW_GRID_LG, ROW_GRID_XL)}>
        <span>Task run</span>
        <span className="hidden xl:block">Trigger · Batch</span>
        <span className="hidden xl:block">Execution</span>
        <span className="w-32 text-right">Judges</span>
        <span className="w-28 text-right">Duration · Cost · Tokens</span>
        <span className="w-36 text-right">{withCompare ? "Started · Compare" : "Started"}</span>
      </div>
    </div>
  );
}

function shouldIgnoreTaskRunNavigation(target: EventTarget | null) {
  return target instanceof HTMLElement
    && target.closest("a, button, input, select, textarea, [role='button'], [role='link']") !== null;
}
