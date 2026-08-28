"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

import { type EffortFacetOption } from "@/lib/agent-task-api";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PrototypeFilterRow,
  type PrototypeStatusOption,
} from "@/components/prototype-unified-filters";
import { shortModel } from "@/lib/run-configuration";
import { ALL_SINCE_VALUE, sinceOptionsFor } from "@/lib/since-window";
import { ModelFilterMenu } from "@/components/model-filter-menu";

import { type ModelOption } from "../runs-model-filter";

// PROTOTYPE: the statuses batch runs actually have. The current toolbar offers
// "Passed", which no batch ever carries (they are completed/partial/…), so that
// option silently filters everything out.
const BATCH_STATUS_OPTIONS: PrototypeStatusOption[] = [
  { value: "queued", label: "Queued", dot: "bg-muted-foreground/30" },
  { value: "running", label: "Running", dot: "bg-foreground/50" },
  { value: "completed", label: "Completed", dot: "bg-success" },
  { value: "partial", label: "Partial", dot: "bg-warning" },
  { value: "failed", label: "Failed", dot: "bg-destructive" },
  { value: "error", label: "Error", dot: "bg-destructive/70" },
];

interface RunsToolbarProps {
  /** Current `?q` value — the search box follows it (see sync note below). */
  urlQ: string;
  urlStatus: string;
  urlSince: string | null;
  selectedModels: Set<string>;
  selectedEfforts: Set<string>;
  modelOptions: ModelOption[];
  effortOptions: EffortFacetOption[];
  totalCount: number;
  /** Any filter dimension in play — typed here or carried in from Tasks. */
  hasActiveFilters: boolean;
  updateUrl: (updates: Record<string, string | null>) => void;
  onClearFilters: () => void;
  /** Retire a model from the palette, or bring it back. */
  onSetArchived: (model: string, archived: boolean) => void;
  /** PROTOTYPE: ?variant= swaps this toolbar for the unified-filter study. */
  prototypeVariant?: string | null;
}

/**
 * Runs page header: breadcrumb plus the filter bar (search, status, model,
 * effort, date). Filter state lives in the URL and is owned by the parent;
 * only the debounced search input is local to this component.
 */
export function RunsToolbar({
  urlQ,
  urlStatus,
  urlSince,
  selectedModels,
  selectedEfforts,
  modelOptions,
  effortOptions,
  totalCount,
  hasActiveFilters,
  updateUrl,
  onClearFilters,
  onSetArchived,
  prototypeVariant = null,
}: RunsToolbarProps) {
  const [searchInput, setSearchInput] = useState(urlQ);
  // Follow ?q changes that did not come from our own typing (initial load,
  // back/forward) by adjusting during render with a prev-value comparison —
  // no effect-time syncing, so no frame ever shows a stale query.
  const [prevUrlQ, setPrevUrlQ] = useState(urlQ);
  if (urlQ !== prevUrlQ) {
    setPrevUrlQ(urlQ);
    setSearchInput(urlQ);
  }
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

  // Status filter (single-select pills).
  const setStatusFilter = useCallback(
    (status: string | null) => {
      updateUrl({ status, page: null });
    },
    [updateUrl],
  );

  // PROTOTYPE: local status state for the unified row. The runs API accepts a
  // single status value, so a multi-select here cannot drive the table yet —
  // the readout under the row shows the URL a multi-status world would write.
  const [protoStatus, setProtoStatus] = useState<Set<string>>(() => new Set());

  if (prototypeVariant) {
    return (
      <div className="shrink-0 border-b border-border bg-background">
        <div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span>Agent Testing</span>
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
            <span className="text-foreground">Runs</span>
          </div>
        </div>
        <div className="border-t border-border px-6 py-2.5">
          <PrototypeFilterRow
            variant={prototypeVariant}
            statusOptions={BATCH_STATUS_OPTIONS}
            status={protoStatus}
            onStatusChange={setProtoStatus}
            modelOptions={modelOptions}
            model={selectedModels.size === 1 ? Array.from(selectedModels)[0] ?? null : null}
            onModelChange={(model) => updateUrl({ model, effort: null, page: null })}
            onSetArchived={onSetArchived}
            effortOptions={effortOptions.map((e) => ({
              value: e.effort,
              label: e.count > 0 ? `${e.effort} (${e.count})` : e.effort,
            }))}
            effort={selectedEfforts.size === 1 ? Array.from(selectedEfforts)[0] ?? null : null}
            onEffortChange={(effort) => updateUrl({ effort, page: null })}
            since={urlSince}
            onSinceChange={(since) => updateUrl({ since, page: null })}
            query={searchInput}
            onQueryChange={handleSearchChange}
            searchPlaceholder="Filter by ID, selection, environment..."
            onClearAll={() => {
              setProtoStatus(new Set());
              onClearFilters();
            }}
            readoutNote="status display-only here: the runs API takes one status value today"
            trailing={
              <>
                {hasActiveFilters && (
                  <button
                    type="button"
                    data-testid="runs-clear-filters"
                    onClick={onClearFilters}
                    className="underline-offset-2 hover:text-foreground/70 hover:underline"
                  >
                    Clear Filters
                  </button>
                )}
                <span>
                  <span className="font-medium text-foreground">{totalCount}</span> runs
                </span>
              </>
            }
          />
        </div>
      </div>
    );
  }

  return (
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
            aria-label="Search runs"
            data-testid="runs-search-input"
            className="h-8 border-border bg-card pl-8 text-[13px] placeholder:text-muted-foreground/50 focus-visible:ring-1"
          />
        </div>

        {/* Status dropdown */}
        <label htmlFor="runs-status-filter" className="flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-foreground/50">Status</span>
          <Select
            value={urlStatus || "all"}
            onValueChange={(v) => setStatusFilter(v === "all" ? null : v)}
          >
            <SelectTrigger id="runs-status-filter" size="sm" data-testid="runs-status-filter" className="h-7 w-[110px] bg-muted/40 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-[12px]">All</SelectItem>
              <SelectItem value="passed" className="text-[12px]">Passed</SelectItem>
              <SelectItem value="failed" className="text-[12px]">Failed</SelectItem>
              <SelectItem value="error" className="text-[12px]">Error</SelectItem>
              <SelectItem value="running" className="text-[12px]">Running</SelectItem>
            </SelectContent>
          </Select>
        </label>

        {/* Model dropdown */}
        <label htmlFor="runs-model-filter" className="flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-foreground/50">Model</span>
          <ModelFilterMenu
            options={modelOptions}
            selected={selectedModels}
            onSelect={(model) => updateUrl({ model, effort: null, page: null })}
            onClear={() => updateUrl({ model: null, effort: null, page: null })}
            onSetArchived={onSetArchived}
            trigger={
              <button
                id="runs-model-filter"
                type="button"
                className="flex h-7 w-[140px] items-center justify-between gap-1 border border-input bg-muted/40 px-2 text-[12px] text-foreground hover:bg-muted/60"
              >
                <span className="truncate font-mono">
                  {selectedModels.size === 1
                    ? shortModel(Array.from(selectedModels)[0]!)
                    : selectedModels.size > 1
                      ? `${selectedModels.size} models`
                      : "All models"}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
              </button>
            }
          />
        </label>

        {/* Effort filter — shown when one model selected with 2+ tiers, or
            whenever an effort is already selected (see runs-client) */}
        {effortOptions.length > 0 && (
          <label htmlFor="runs-effort-filter" className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] uppercase tracking-wide text-foreground/50">Effort</span>
            <Select
              value={selectedEfforts.size === 1 ? Array.from(selectedEfforts)[0] : "__any"}
              onValueChange={(v) => {
                if (v === "__any") updateUrl({ effort: null, page: null });
                else updateUrl({ effort: v, page: null });
              }}
            >
              <SelectTrigger id="runs-effort-filter" data-testid="runs-effort-filter" size="sm" className="h-7 w-[100px] bg-muted/40 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any" className="text-[12px]">Any</SelectItem>
                {effortOptions.map((e) => (
                  <SelectItem key={e.effort} value={e.effort} className="text-[12px]">
                    {e.count > 0 ? `${e.effort} (${e.count})` : e.effort}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        )}

        {/* Date filter */}
        <label htmlFor="runs-date-filter" className="flex shrink-0 items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-foreground/50">Date</span>
          <Select
            value={urlSince ?? ALL_SINCE_VALUE}
            onValueChange={(v) =>
              updateUrl({ since: v === ALL_SINCE_VALUE ? null : v, page: null })
            }
          >
            <SelectTrigger id="runs-date-filter" data-testid="runs-date-filter" size="sm" className="h-7 w-[100px] bg-muted/40 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sinceOptionsFor(urlSince).map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-[12px]">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
          {/* Filters can arrive with the navigation (a cohort carried over from
              Tasks), so the way back to the full list has to be one click. */}
          {hasActiveFilters && (
            <button
              type="button"
              data-testid="runs-clear-filters"
              onClick={onClearFilters}
              className="underline-offset-2 hover:text-foreground/70 hover:underline"
            >
              Clear Filters
            </button>
          )}
          <span>
            <span className="font-medium text-foreground">{totalCount}</span> runs
          </span>
        </div>
      </div>
    </div>
  );
}
