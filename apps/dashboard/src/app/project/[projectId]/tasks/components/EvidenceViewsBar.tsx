"use client";

import { ChevronDown, Plus, Search, X } from "lucide-react";

import type { RunConfigModelFacet } from "@/lib/agent-task-view-api";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import { FilterPicker } from "./FilterPicker";
import {
  ALL_SINCE_VALUE,
  MAIN_VIEW_ID,
  SINCE_OPTIONS,
  STATUS_FILTERS,
  type ViewTab,
} from "./task-list-shared";

const ALL_MODELS_VALUE = "__all__";
const ANY_EFFORT_VALUE = "__any__";

/** A short, human-readable config line for a tab chip (e.g. "Opus · high"). */
function viewConfigLabel(view: ViewTab): string {
  if (view.model === null && view.effort === null && view.since === null) return "everything";
  const parts: string[] = [view.model ?? "all models"];
  if (view.effort) parts.push(view.effort);
  if (view.since) parts.push(view.since);
  return parts.join(" · ");
}

export function EvidenceViewsBar({
  views,
  activeViewId,
  facets,
  loading,
  isDerived,
  viewsActive,
  addingTab,
  query,
  onQueryChange,
  selectedCount,
  onClearSelection,
  onToggleExpandAll,
  allExpanded,
  statusFilter,
  onToggleStatus,
  onSelect,
  onChange,
  onDuplicate,
  onClose,
}: {
  views: ViewTab[];
  activeViewId: string;
  facets: RunConfigModelFacet[];
  loading: boolean;
  isDerived: boolean;
  viewsActive: boolean;
  addingTab: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  selectedCount: number;
  onClearSelection: () => void;
  onToggleExpandAll: () => void;
  allExpanded: boolean;
  statusFilter: Set<string>;
  onToggleStatus: (status: string) => void;
  onSelect: (id: string) => void;
  onChange: (patch: Partial<Pick<ViewTab, "model" | "effort" | "since" | "label">>) => void;
  onDuplicate: () => void;
  onClose: (id: string) => void;
}) {
  const active = views.find((v) => v.id === activeViewId) ?? views[0]!;
  const activeModelFacet = facets.find((f) => f.model === active.model);
  // Effort is model-aware: only reveal the control for a specific model that
  // has 2+ distinct effort tiers in the data (SPEC-174 / option B).
  const effortOptions =
    active.model !== null && activeModelFacet && activeModelFacet.efforts.length > 1
      ? activeModelFacet.efforts
      : [];

  function changeModel(value: string) {
    const model = value === ALL_MODELS_VALUE ? null : value;
    // Clear effort if the new model no longer has it, so the view never
    // carries a filter the UI cannot show.
    const facet = facets.find((f) => f.model === model);
    const keepsEffort = facet ? facet.efforts.some((e) => e.effort === active.effort) : false;
    onChange({ model, effort: keepsEffort ? active.effort : null });
  }

  return (
    <div className="border-b border-border bg-muted/10">
      {/* Tabs: Main is permanent; every other tab is a closable derived copy.
          Hidden entirely for demo projects (no views there). */}
      {viewsActive && (
        <div className="flex flex-wrap items-stretch gap-1 bg-muted/20 px-6 py-2">
          {views.map((v) => {
            const isActive = v.id === activeViewId;
            const isMain = v.id === MAIN_VIEW_ID;
            return (
              // One bordered unit per tab: the select area + an inline close on
              // its right edge (Main has no close — it's permanent). Mirrors the
              // conventional editor/browser tab shape rather than a separate
              // close column.
              <div
                key={v.id}
                className={cn(
                  "flex items-stretch border transition-colors",
                  isActive
                    ? "border-foreground/40 bg-foreground/[0.08]"
                    : "border-foreground/15 hover:border-foreground/30 hover:bg-foreground/[0.05]",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(v.id)}
                  className="relative flex flex-col items-start gap-0.5 px-3 py-1.5 text-left"
                >
                  {isActive && (
                    <span className="pointer-events-none absolute inset-y-1 left-0 w-[2px] bg-foreground" aria-hidden />
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className={cn("text-[13px] font-medium", isActive ? "text-foreground" : "text-foreground/70")}>
                      {v.label}
                    </span>
                    {isMain && (
                      <span className="border border-foreground/25 px-1 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">
                        main
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">{viewConfigLabel(v)}</span>
                </button>
                {!isMain && (
                  <button
                    type="button"
                    aria-label={`Close ${v.label} tab`}
                    onClick={() => onClose(v.id)}
                    className="grid place-items-center border-l border-foreground/10 px-1.5 text-muted-foreground/50 hover:bg-destructive/20 hover:text-destructive"
                    title="Close tab"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={onDuplicate}
            disabled={addingTab}
            aria-label="Add a new view tab"
            className="grid place-items-center border border-dashed border-foreground/20 px-3 text-foreground/60 hover:border-foreground/40 hover:bg-foreground/[0.05] disabled:opacity-40"
            title="Add a new view tab (starts as a copy of the active one)"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* One unified filter row: text search + (Model + model-aware Effort when
          views are active) + selection + expand. */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-2">
        <div className="relative min-w-[200px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Filter tasks..."
            aria-label="Filter tasks"
            data-testid="tasks-search-input"
            className="h-8 border-border bg-card pl-8 text-[13px] placeholder:text-muted-foreground/50 focus-visible:border-border"
          />
        </div>
        {viewsActive && (
          <>
            <FilterPicker
              label="Model"
              value={active.model ?? ALL_MODELS_VALUE}
              options={[
                { value: ALL_MODELS_VALUE, label: "All models" },
                ...facets.map((f) => ({ value: f.model, label: f.model })),
              ]}
              onChange={changeModel}
            />
            {effortOptions.length > 0 && (
              <FilterPicker
                label="Effort"
                value={active.effort ?? ANY_EFFORT_VALUE}
                options={[
                  { value: ANY_EFFORT_VALUE, label: "Any effort" },
                  ...effortOptions.map((e) => ({ value: e.effort, label: e.effort })),
                ]}
                onChange={(value) => onChange({ effort: value === ANY_EFFORT_VALUE ? null : value })}
              />
            )}
            <FilterPicker
              label="Date"
              value={active.since ?? ALL_SINCE_VALUE}
              options={SINCE_OPTIONS}
              onChange={(value) => onChange({ since: value === ALL_SINCE_VALUE ? null : value })}
            />
            {viewsActive && (
              <label className="flex shrink-0 items-center gap-1.5">
                <span className="text-[11px] uppercase tracking-wide text-foreground/50">Status</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-7 items-center gap-1 border border-input bg-muted/40 px-2 text-[12px] text-foreground hover:bg-muted/60"
                    >
                      {statusFilter.size === STATUS_FILTERS.length ? "All" : `${statusFilter.size}/${STATUS_FILTERS.length}`}
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {STATUS_FILTERS.map((s) => (
                      <DropdownMenuCheckboxItem
                        key={s.key}
                        checked={statusFilter.has(s.key)}
                        onCheckedChange={() => onToggleStatus(s.key)}
                        className="text-[12px]"
                      >
                        <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", s.dot)} />
                        {s.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </label>
            )}
            {isDerived && (
              <span className="font-mono text-[10px] text-muted-foreground/50">
                {loading ? "loading scoped stats…" : "scoped to this view"}
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
          {selectedCount > 0 && (
            <>
              <button
                type="button"
                onClick={onClearSelection}
                className="underline-offset-2 hover:text-foreground/70 hover:underline"
              >
                <span className="font-medium text-foreground/70">{selectedCount}</span> selected
              </button>
              <div className="h-4 w-px bg-border" />
            </>
          )}
          <button type="button" onClick={onToggleExpandAll} className="hover:text-foreground/70">
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </div>
    </div>
  );
}
