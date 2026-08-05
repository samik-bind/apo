"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  GitBranch,
  GitCompare,
  History,
  Loader2,
  Play,
  Search,
  Zap,
} from "lucide-react";
import {
  type AgentTaskBatchRunSummary,
  type AgentTaskRunSummary,
  type ModelFacetOption,
  getAgentTaskBatchRun,
} from "@/lib/agent-task-api";
import { type ProjectTaskSource } from "@/lib/projects-api";

import { TASK_RUN_STATUS, type TaskRunStatus } from "@/components/task-run-list.utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { parseUTC, formatCostMicro, formatTokenTotal } from "@/lib/format";
import { formatBatchExecution, formatRunExecution, formatRunExecutionFull } from "@/lib/run-configuration";

import { useProjectId } from "@/lib/project-router";
import { useClientNow } from "@/hooks/use-client-now";
import { conclusionStyle } from "@/components/run-outcome";
import { RunsModelFilter, type ModelOption } from "./runs-model-filter";

const COL = {
  chevron: 28,
  run: "auto",
  source: 150,
  execution: 180,
  tasks: 180,
  duration: 110,
  created: 150,
} as const;

function formatDate(value: string | null): string {
  if (!value) return "\u2014";
  const d = parseUTC(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatRelative(value: string | null, nowMs: number | null): string {
  if (!value) return "\u2014";
  if (nowMs === null) return "\u2026";
  const date = parseUTC(value);
  const diffMs = nowMs - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return formatDate(value);
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "\u2014";
  const startMs = parseUTC(start).getTime();
  const endMs = end ? parseUTC(end).getTime() : Date.now();
  const ms = endMs - startMs;
  if (ms < 0) return "\u2014";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function formatTrigger(trigger: { source: string | null; actor: string | null; schedule_name?: string | null } | null): string {
  if (!trigger) return "Manual";
  if (trigger.source === "schedule") {
    return trigger.schedule_name ? `Scheduled \u00b7 ${trigger.schedule_name}` : "Scheduled";
  }
  if (trigger.source === "manual") return "Manual";
  if (trigger.source === "ci") return "CI / Pipeline";
  if (trigger.actor) return trigger.actor;
  return trigger.source ?? "Manual";
}

export function RunsClient({
  batchRuns,
  error: _error,
  taskSource,
  totalCount,
  page,
  pageSize,
  totalPages,
  modelFacets,
}: {
  batchRuns: AgentTaskBatchRunSummary[];
  error: string | null;
  taskSource: ProjectTaskSource | null;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  modelFacets: ModelFacetOption[];
}) {
  const projectId = useProjectId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const clientNow = useClientNow();
  const sourceUnconfigured = taskSource === null && totalCount === 0;

  const updateUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  const urlQ = searchParams.get("q") ?? "";
  const [searchInput, setSearchInput] = useState(urlQ);
  useEffect(() => {
    setSearchInput(urlQ);
  }, [urlQ]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchInput(value);
      clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => {
        updateUrl({ q: value || null, page: null });
      }, 350);
    },
    [updateUrl],
  );

  const selectedModels = useMemo(() => {
    const raw = searchParams.get("model") ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }, [searchParams]);

  const toggleModel = useCallback(
    (model: string) => {
      const next = new Set(selectedModels);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      updateUrl({ model: Array.from(next).join(",") || null, page: null });
    },
    [selectedModels, updateUrl],
  );
  const clearModels = useCallback(() => {
    updateUrl({ model: null, page: null });
  }, [updateUrl]);

  const modelOptions: ModelOption[] = useMemo(
    () =>
      modelFacets
        .map((f) => ({ model: f.model, count: f.count }))
        .sort((a, b) => a.model.localeCompare(b.model)),
    [modelFacets],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      updateUrl({ page: newPage === 0 ? null : String(newPage) });
    },
    [updateUrl],
  );

  const [compareIds, setCompareIds] = useState<string[]>([]);
  const compareIdSet = useMemo(() => new Set(compareIds), [compareIds]);
  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return prev.length >= 2 ? [prev[1], id] : [...prev, id];
    });
  }, []);
  const clearCompare = useCallback(() => setCompareIds([]), []);

  const compareBatches = useMemo(
    () => compareIds.map((id) => batchRuns.find((b) => b.id === id) ?? null),
    [compareIds, batchRuns],
  );
  const overlap = useMemo(
    () =>
      compareBatches.length === 2 && compareBatches[0] && compareBatches[1]
        ? computeOverlap(compareBatches[0], compareBatches[1])
        : null,
    [compareBatches],
  );

  const showingFrom = totalCount === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, totalCount);

  return (
    <div className="flex h-full w-full flex-col">
      <div className="shrink-0 border-b border-border bg-background">
        <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span>Agent Testing</span>
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            <span className="text-foreground">Runs</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-2.5">
          <div className="relative max-w-md min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Filter by ID, selection, environment..."
              className="h-8 border-border bg-card pl-8 text-[13px] placeholder:text-muted-foreground/50 focus-visible:ring-1"
            />
          </div>
          <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
            <span>
              <span className="font-medium text-foreground">{totalCount}</span> runs
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {sourceUnconfigured ? (
          <div className="px-6 py-10">
            <div className="px-6 py-10 text-center text-sm text-neutral-400">
              Run <code className="text-neutral-200">apo task publish</code> to publish your task catalog.
            </div>
          </div>
        ) : batchRuns.length === 0 ? (
          <div className="m-6 rounded-md border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
            <History className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
            {totalCount === 0
              ? <>No runs yet. <Link href={`/project/${projectId}/tasks`} className="text-primary underline underline-offset-4">Discover and run tasks</Link></>
              : "No runs match your filters."}
          </div>
        ) : (
          <Table density="compact">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead style={{ width: COL.chevron }} />
                <TableHead>Run</TableHead>
                <TableHead style={{ width: COL.source }} className="hidden xl:table-cell">Source</TableHead>
                <TableHead style={{ width: COL.execution }}>
                  <span className="inline-flex items-center gap-1">
                    Execution
                    <RunsModelFilter
                      options={modelOptions}
                      selected={selectedModels}
                      onToggle={toggleModel}
                      onClear={clearModels}
                    />
                  </span>
                </TableHead>
                <TableHead style={{ width: COL.tasks }} className="text-right">Tasks {"\u00b7"} Pass rate</TableHead>
                <TableHead style={{ width: COL.duration }} className="text-right">Duration</TableHead>
                <TableHead style={{ width: COL.created }} className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batchRuns.map((b) => (
                <RunsRow
                  key={b.id}
                  batch={b}
                  clientNow={clientNow}
                  projectId={projectId}
                  compareSelected={compareIdSet.has(b.id)}
                  compareDisabled={compareIds.length >= 2 && !compareIdSet.has(b.id)}
                  onToggleCompare={() => toggleCompare(b.id)}
                  modelFilter={selectedModels}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-border px-6 py-3 text-[12px] text-muted-foreground">
        <span>
          {totalCount > 0 && (
            <>Showing <span className="font-mono text-foreground">{showingFrom}{"\u2013"}{showingTo}</span> of </>
          )}
          <span className="font-mono text-foreground">{totalCount}</span> runs
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[12px] font-normal"
              disabled={page === 0}
              onClick={() => handlePageChange(page - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Prev
            </Button>
            <span className="font-mono tabular-nums">
              Page {page + 1} of {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1 px-2 text-[12px] font-normal"
              disabled={page >= totalPages - 1}
              onClick={() => handlePageChange(page + 1)}
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>

      {compareIds.length > 0 && (
        <div className="sticky bottom-4 z-20 mx-auto mb-4 w-fit">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-2xl shadow-black/60">
            <GitCompare className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2 text-[12px]">
              {compareIds.map((id, i) => {
                const batch = compareBatches[i];
                return (
                  <span key={id} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-muted-foreground/40">vs</span>}
                    <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                      {batch ? getBatchName(batch) : id.slice(0, 8)}
                    </span>
                  </span>
                );
              })}
              {compareIds.length === 2 && (
                <span className="text-muted-foreground">
                  {overlap ? (
                    overlap.shared === 0 ? (
                      <span className="text-muted-foreground/70">no shared tasks</span>
                    ) : (
                      <>
                        <span className="font-mono tabular-nums text-foreground">{overlap.shared}</span> shared
                        {overlap.onlyA > 0 && (
                          <> {"\u00b7"} <span className="font-mono tabular-nums">{overlap.onlyA}</span> only A</>
                        )}
                        {overlap.onlyB > 0 && (
                          <> {"\u00b7"} <span className="font-mono tabular-nums">{overlap.onlyB}</span> only B</>
                        )}
                      </>
                    )
                  ) : (
                    <span className="text-muted-foreground/60">
                      {compareBatches[0] && compareBatches[1] ? "overlap unknown" : "select both on one page"}
                    </span>
                  )}
                </span>
              )}
            </div>
            <div className="h-5 w-px bg-border" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground"
              onClick={clearCompare}
            >
              Clear
            </Button>
            {compareIds.length === 2 && overlap !== null && overlap.shared === 0 ? (
              <span className="text-[12px] text-muted-foreground/70">Nothing to compare</span>
            ) : compareIds.length === 2 ? (
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1.5 px-3 text-[12px] font-medium"
                asChild
              >
                <Link href={`/project/${projectId}/runs/compare?a=${compareIds[0]}&b=${compareIds[1]}`}>
                  Compare
                </Link>
              </Button>
            ) : (
              <span className="text-[12px] text-muted-foreground">Select one more</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function getTaskPaths(batch: AgentTaskBatchRunSummary): string[] {
  const q = batch.selection_query;
  if (q && typeof q === "object" && "task_paths" in q) {
    const paths = q.task_paths;
    if (Array.isArray(paths)) return paths.map((p: string) => p.split("/").pop() ?? p);
  }
  return [];
}

function getFullTaskPaths(batch: AgentTaskBatchRunSummary): string[] {
  const q = batch.selection_query;
  if (q && typeof q === "object" && "task_paths" in q) {
    const paths = q.task_paths;
    if (Array.isArray(paths) && paths.length > 0) return paths as string[];
  }
  return [];
}

function computeOverlap(
  a: AgentTaskBatchRunSummary,
  b: AgentTaskBatchRunSummary,
): { shared: number; onlyA: number; onlyB: number } | null {
  const aPaths = new Set(getFullTaskPaths(a));
  const bPaths = new Set(getFullTaskPaths(b));
  if (aPaths.size === 0 || bPaths.size === 0) return null;
  let shared = 0;
  for (const p of aPaths) if (bPaths.has(p)) shared++;
  return { shared, onlyA: aPaths.size - shared, onlyB: bPaths.size - shared };
}

function getBatchName(batch: AgentTaskBatchRunSummary): string {
  const paths = getTaskPaths(batch);
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) return `${paths.length} tasks`;
  if (batch.selection_type === "all") return "All discovered tasks";
  return batch.selection_type;
}

function getSourceIcon(source: string | null): React.ComponentType<{ className?: string }> {
  if (source === "schedule") return CalendarClock;
  if (source === "ci") return GitBranch;
  if (source === "dashboard") return Play;
  return Zap;
}

function RunsRow({
  batch,
  clientNow,
  projectId,
  compareSelected,
  compareDisabled,
  onToggleCompare,
  modelFilter,
}: {
  batch: AgentTaskBatchRunSummary;
  clientNow: number | null;
  projectId: string;
  compareSelected: boolean;
  compareDisabled: boolean;
  onToggleCompare: () => void;
  modelFilter: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [taskRuns, setTaskRuns] = useState<AgentTaskRunSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const s = conclusionStyle({
    status: batch.status,
    passed: batch.passed_tasks,
    failed: batch.failed_tasks,
    errored: batch.errored_tasks,
    total: batch.total_tasks,
  });
  const checkTotal = Math.max(batch.total_checks, 1);
  const passRate = Math.round((batch.passed_checks / checkTotal) * 100);
  const isRunning = batch.status === "running" || batch.status === "queued";
  const showRate = batch.total_checks > 0 || !isRunning;
  const triggerLabel = formatTrigger(batch.trigger);
  const SourceIcon = getSourceIcon(batch.trigger?.source ?? null);
  const batchName = getBatchName(batch);
  const taskPaths = getTaskPaths(batch);
  const branch = (batch.trigger as Record<string, unknown> | null)?.branch as string | null;
  const commit = (batch.trigger as Record<string, unknown> | null)?.commit_sha as string | null;

  const handleToggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && taskRuns === null && !loading) {
      setLoading(true);
      setError(null);
      try {
        const detail = await getAgentTaskBatchRun(batch.id);
        setTaskRuns(detail.task_runs ?? []);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load task runs");
      } finally {
        setLoading(false);
      }
    }
  }, [expanded, taskRuns, loading, batch.id]);

  return (
    <>
      <TableRow className="group cursor-default border-border/60 transition-colors hover:bg-muted/30">
        <TableCell className="px-2">
          {batch.total_tasks > 1 ? (
            <button
              type="button"
              onClick={handleToggle}
              aria-label={expanded ? "Collapse task runs" : "Expand task runs"}
              aria-expanded={expanded}
              className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {loading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded ? "" : "-rotate-90")} />}
            </button>
          ) : null}
        </TableCell>

        <TableCell>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", s.dot)}
                role="img"
                aria-label={s.label}
                title={s.label}
              />
              <Link
                href={`/project/${projectId}/runs/${batch.id}`}
                className="truncate text-[14px] font-medium text-foreground hover:text-primary"
              >
                {batchName}
              </Link>
            </div>
            <div className="mt-1 flex items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
              <span className="shrink-0 font-mono text-muted-foreground/60">{batch.id.slice(0, 8)}</span>
              {branch && (
                <>
                  <span className="shrink-0 text-muted-foreground/30">·</span>
                  <span className="inline-flex shrink-0 items-center gap-1">
                    <GitBranch className="h-3 w-3 text-muted-foreground/50" />
                    <span className="font-mono">{branch}</span>
                    {commit && <span className="font-mono text-muted-foreground/50">@{commit.slice(0, 7)}</span>}
                  </span>
                </>
              )}
              {taskPaths.length > 1 && (
                <>
                  <span className="shrink-0 text-muted-foreground/30">·</span>
                  <span className="shrink-0 truncate text-muted-foreground">
                    {taskPaths.slice(0, 3).join(" · ")}
                    {taskPaths.length > 3 && <span className="ml-1">+{taskPaths.length - 3}</span>}
                  </span>
                </>
              )}
            </div>
          </div>
        </TableCell>

        <TableCell className="hidden xl:table-cell">
          <div className="flex items-center gap-2">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded border border-border bg-card">
              <SourceIcon className="h-3 w-3 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <div className="truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {triggerLabel}
              </div>
            </div>
          </div>
        </TableCell>

        <TableCell>
          <span className="truncate font-mono text-[12px] tabular-nums text-muted-foreground" title={formatBatchExecution(batch.configuration)}>
            {formatBatchExecution(batch.configuration)}
          </span>
        </TableCell>

        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-2 font-mono text-[13px] tabular-nums">
            <span className={cn(
              "tabular-nums",
              showRate
                ? (passRate >= 95 ? "text-success" : passRate >= 80 ? "text-foreground" : "text-destructive")
                : "text-muted-foreground",
            )}>{showRate ? `${passRate}%` : "\u2014"}</span>
            <span className="text-muted-foreground/40">·</span>
            <span className="text-muted-foreground text-[12px]">{batch.passed_tasks}/{batch.total_tasks} tasks</span>
          </div>
          <div className="mt-1.5 flex justify-end">
            {isRunning ? (
              <span className="font-mono text-[11px] text-muted-foreground">running...</span>
            ) : (
              <div className="h-1 w-24 overflow-hidden rounded-full bg-border">
                <div
                  className={cn("h-full", passRate >= 95 ? "bg-success" : passRate < 80 ? "bg-destructive" : "bg-foreground/30")}
                  style={{ width: `${passRate}%` }}
                />
              </div>
            )}
          </div>
        </TableCell>

        <TableCell className="text-right">
          <div className="inline-flex items-center justify-end gap-1.5 font-mono text-[13px] tabular-nums text-foreground">
            <Clock className="h-3 w-3 text-muted-foreground/50" />
            {formatDuration(batch.started_at, batch.completed_at)}
          </div>
          {batch.total_cost != null && batch.total_cost > 0 && (
            <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
              {formatCostMicro(batch.total_cost)}
            </div>
          )}
          {batch.total_tokens != null && batch.total_tokens > 0 && (
            <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {formatTokenTotal(batch.total_tokens)}
            </div>
          )}
        </TableCell>

        <TableCell>
          <div className="flex items-center justify-end gap-2">
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
              {formatRelative(batch.created_at, clientNow)}
            </span>
            <button
              type="button"
              onClick={onToggleCompare}
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
            <Link
              href={`/project/${projectId}/runs/${batch.id}`}
              aria-label="Open batch run"
              className="text-muted-foreground transition-opacity hover:text-foreground"
            >
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <>
          {loading && (
            <TableRow className="bg-white/10 hover:bg-transparent">
              <TableCell colSpan={7} className="py-6">
                <div className="flex items-center justify-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading task runs{"\u2026"}
                </div>
              </TableCell>
            </TableRow>
          )}
          {!loading && error && (
            <TableRow className="bg-white/10 hover:bg-transparent">
              <TableCell colSpan={7} className="py-6 text-center text-[12px] text-destructive">{error}</TableCell>
            </TableRow>
          )}
          {!loading && !error && taskRuns !== null && (() => {
            const visible = modelFilter.size > 0
              ? taskRuns.filter((tr) => {
                  const m = tr.run_configuration?.model;
                  return typeof m === "string" && modelFilter.has(m);
                })
              : taskRuns;
            if (visible.length === 0) {
              return (
                <TableRow className="bg-white/10 hover:bg-transparent">
                  <TableCell colSpan={7} className="py-6 text-center text-[12px] text-muted-foreground">
                    {taskRuns.length === 0
                      ? "No task runs were recorded for this run."
                      : "No task runs match the current model filter."}
                  </TableCell>
                </TableRow>
              );
            }
            return visible.map((run) => (
              <InlineTaskRunRow key={run.id} run={run} projectId={projectId} clientNow={clientNow} />
            ));
          })()}
        </>
      )}
    </>
  );
}

function InlineTaskRunRow({ run, projectId, clientNow }: { run: AgentTaskRunSummary; projectId: string; clientNow: number | null }) {
  const status = run.status in TASK_RUN_STATUS ? (run.status as TaskRunStatus) : "pending";
  const statusConfig = TASK_RUN_STATUS[status];
  const isDone = status === "passed" || status === "failed";
  const isInactive = status === "pending" || status === "error";
  const passRate = run.total_checks > 0 ? Math.round((run.passed_checks / run.total_checks) * 100) : 0;

  return (
    <TableRow className="group cursor-default border-border/60 bg-white/10 transition-colors hover:bg-white/15">
      <TableCell className="border-l-2 border-l-white/30 px-2 py-3" />

      <TableCell className="pl-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span
              className={cn("h-2 w-2 shrink-0 rounded-full", statusConfig.dot)}
              role="img"
              aria-label={statusConfig.label}
            />
            <Link
              href={`/project/${projectId}/runs/task/${run.id}`}
              className="truncate text-[13px] font-medium text-foreground hover:text-primary"
            >
              {run.task_id}
            </Link>
          </div>
          <div className="mt-1 flex items-center gap-x-2 text-[11px] text-muted-foreground">
            {run.adapter_name && (
              <span className="shrink-0 font-mono text-muted-foreground/60">{run.adapter_name}</span>
            )}
            {run.error_message && (
              <>
                <span className="shrink-0 text-muted-foreground/30">·</span>
                <span className="truncate text-destructive">{run.error_message.slice(0, 80)}</span>
              </>
            )}
          </div>
        </div>
      </TableCell>

      <TableCell aria-hidden className="hidden xl:table-cell" />

      <TableCell>
        <span
          className="truncate font-mono text-[12px] tabular-nums text-muted-foreground"
          title={formatRunExecutionFull(run.run_configuration)}
        >
          {formatRunExecution(run.run_configuration)}
        </span>
      </TableCell>

      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-2 font-mono text-[12px] tabular-nums">
          {isInactive || run.total_checks === 0 ? (
            <span className="text-muted-foreground">&mdash;</span>
          ) : (
            <>
              <span className={cn("tabular-nums", status === "passed" ? "text-success" : status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {passRate}%
              </span>
              <span className="text-muted-foreground/40">·</span>
              <span className="text-muted-foreground">{run.passed_checks}/{run.total_checks} checks</span>
            </>
          )}
        </div>
        {isDone && run.total_checks > 0 && (
          <div className="mt-1.5 flex justify-end">
            <div className="h-1 w-24 overflow-hidden rounded-full bg-border">
              <div
                className={cn("h-full", passRate >= 95 ? "bg-success" : passRate < 80 ? "bg-destructive" : "bg-foreground/30")}
                style={{ width: `${passRate}%` }}
              />
            </div>
          </div>
        )}
      </TableCell>

      <TableCell className="text-right">
        <div className="inline-flex items-center justify-end gap-1.5 font-mono text-[12px] tabular-nums text-foreground">
          <Clock className="h-3 w-3 text-muted-foreground/50" />
          {formatDuration(run.started_at, run.completed_at)}
        </div>
        {run.total_cost != null && run.total_cost > 0 && (
          <div className="mt-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatCostMicro(run.total_cost)}
          </div>
        )}
        {run.total_tokens != null && run.total_tokens > 0 && (
          <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatTokenTotal(run.total_tokens)}
          </div>
        )}
      </TableCell>

      <TableCell>
        <div className="flex items-center justify-end gap-2">
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {formatRelative(run.started_at, clientNow)}
          </span>
          <Link
            href={`/project/${projectId}/runs/task/${run.id}`}
            aria-label="Open task run"
            className="text-muted-foreground transition-opacity hover:text-foreground"
          >
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </TableCell>
    </TableRow>
  );
}
