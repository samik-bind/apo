"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";

import { ModelFilterMenu } from "@/components/model-filter-menu";
import { FilterPicker } from "@/app/project/[projectId]/tasks/components/FilterPicker";
import { fetchSavedViews } from "@/lib/agent-task-view-api";
import type { RunConfigModelFacet } from "@/lib/agent-task-view-api";
import { parseRunCohort, type RunCohort } from "@/lib/run-cohort";
import { shortModel } from "@/lib/run-configuration";
import { ALL_SINCE_VALUE, sinceOptionsFor } from "@/lib/since-window";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The task detail page's run-history scope.
 *
 * The URL is the source of truth: the bar reads `?model=&effort=&since=&status=&view=`,
 * and every control change replaces the search params (never pushes — back must
 * leave the task page, not step through filter states). The `view` param is
 * informational only: it names the saved view the user arrived from and hides
 * itself once the scope diverges from that view.
 */

const ANY_EFFORT_VALUE = "__any__";

/** Run-level statuses — "idle" is a task-list concept and deliberately absent. */
const RUN_STATUS_CHIPS = [
  { value: "passed", label: "Passed", dot: "bg-success" },
  { value: "failed", label: "Failed", dot: "bg-destructive" },
  { value: "error", label: "Errored", dot: "bg-warning" },
] as const;

export interface TaskRunHistoryScope extends RunCohort {
  status: Set<string>;
}

export function TaskRunHistoryControls({
  scope,
  facets,
  viewLabel,
  onScopeChange,
  onReset,
}: {
  scope: TaskRunHistoryScope;
  facets: RunConfigModelFacet[];
  viewLabel: string | null;
  onScopeChange: (next: Partial<TaskRunHistoryScope>) => void;
  onReset: () => void;
}) {
  const effortTiers = facets.find((f) => f.model === scope.model)?.efforts ?? [];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-foreground/50">Model</span>
        <ModelFilterMenu
          options={facets}
          selected={scope.model ? new Set([scope.model]) : new Set()}
          onSelect={(model) => onScopeChange({ model, effort: null })}
          onClear={() => onScopeChange({ model: null, effort: null })}
          trigger={
            <button
              type="button"
              aria-label="Model filter"
              className="flex h-7 min-w-[140px] items-center justify-between gap-1 border border-input bg-muted/40 px-2 text-[12px] text-foreground hover:bg-muted/60"
            >
              <span className="truncate font-mono">
                {scope.model ? shortModel(scope.model) : "All models"}
              </span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          }
        />
      </div>

      {effortTiers.length >= 2 && (
        <FilterPicker
          label="Effort"
          value={scope.effort ?? ANY_EFFORT_VALUE}
          options={[
            { value: ANY_EFFORT_VALUE, label: "Any effort" },
            ...effortTiers.map((tier) => ({
              value: tier.effort,
              label: tier.effort,
            })),
          ]}
          onChange={(value) =>
            onScopeChange({ effort: value === ANY_EFFORT_VALUE ? null : value })
          }
        />
      )}

      <FilterPicker
        label="Date"
        value={scope.since ?? ALL_SINCE_VALUE}
        options={sinceOptionsFor(scope.since)}
        onChange={(value) => onScopeChange({ since: value === ALL_SINCE_VALUE ? null : value })}
      />

      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-foreground/50">Status</span>
        <div className="flex items-center gap-1">
          {RUN_STATUS_CHIPS.map((chip) => {
            const active = scope.status.has(chip.value);
            return (
              <button
                key={chip.value}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  const next = new Set(scope.status);
                  if (active) next.delete(chip.value);
                  else next.add(chip.value);
                  onScopeChange({ status: next });
                }}
                className={cn(
                  "flex h-7 items-center gap-1.5 border px-2 text-[12px] transition-colors",
                  active
                    ? "border-foreground/30 bg-muted/60 text-foreground"
                    : "border-input bg-muted/40 text-muted-foreground hover:bg-muted/60",
                )}
              >
                <span className={cn("h-2 w-2 rounded-full", chip.dot)} aria-hidden />
                {chip.label}
              </button>
            );
          })}
        </div>
      </div>

      {viewLabel && (
        <span className="text-[11px] text-muted-foreground">{`scoped to view: ${viewLabel}`}</span>
      )}

      <button
        type="button"
        onClick={onReset}
        className="text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        All history
      </button>
    </div>
  );
}

interface SavedViewShape {
  id: string;
  label: string;
  model: string | null;
  effort: string | null;
  since: string | null;
}

export function RunHistoryScopeBar({
  projectId,
  facets,
}: {
  projectId: string;
  facets: RunConfigModelFacet[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const viewId = searchParams.get("view");
  const scope = useMemo<TaskRunHistoryScope>(() => {
    const cohort = parseRunCohort(Object.fromEntries(searchParams.entries()));
    return { ...cohort, status: new Set(searchParams.getAll("status")) };
  }, [searchParams]);

  const [view, setView] = useState<SavedViewShape | null>(null);
  useEffect(() => {
    if (!viewId) {
      setView(null);
      return;
    }
    let cancelled = false;
    fetchSavedViews(projectId)
      .then((views) => {
        if (cancelled) return;
        setView(views.find((v) => v.id === viewId) ?? null);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, viewId]);

  // The chip disappears once the scope no longer matches the view it names.
  const viewLabel =
    view &&
    view.model === scope.model &&
    view.effort === scope.effort &&
    view.since === scope.since
      ? view.label
      : null;

  const writeParams = (next: TaskRunHistoryScope, keepView: boolean) => {
    const params = new URLSearchParams();
    if (next.model) params.set("model", next.model);
    if (next.effort) params.set("effort", next.effort);
    if (next.since) params.set("since", next.since);
    for (const status of next.status) params.append("status", status);
    if (keepView && viewId) params.set("view", viewId);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  };

  const merged = (patch: Partial<TaskRunHistoryScope>): TaskRunHistoryScope => ({
    model: patch.model !== undefined ? patch.model : scope.model,
    effort: patch.effort !== undefined ? patch.effort : scope.effort,
    since: patch.since !== undefined ? patch.since : scope.since,
    status: patch.status !== undefined ? patch.status : scope.status,
  });

  return (
    <TaskRunHistoryControls
      scope={scope}
      facets={facets}
      viewLabel={viewLabel}
      onScopeChange={(patch) => writeParams(merged(patch), true)}
      onReset={() => writeParams({ ...scope, model: null, effort: null, since: null, status: new Set() }, true)}
    />
  );
}
