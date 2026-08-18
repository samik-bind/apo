"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";

import { type EffortFacetOption } from "@/lib/agent-task-api";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { shortModel } from "@/lib/run-configuration";

import { type ModelOption } from "../runs-model-filter";

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
  updateUrl: (updates: Record<string, string | null>) => void;
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
  updateUrl,
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
          <Select
            value={selectedModels.size === 1 ? Array.from(selectedModels)[0] : selectedModels.size > 1 ? "__multi" : "__all"}
            onValueChange={(v) => {
              if (v === "__all") updateUrl({ model: null, effort: null, page: null });
              else updateUrl({ model: v, effort: null, page: null });
            }}
          >
            <SelectTrigger id="runs-model-filter" size="sm" className="h-7 w-[140px] bg-muted/40 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all" className="text-[12px]">All models</SelectItem>
              {modelOptions.map((opt) => (
                <SelectItem key={opt.model} value={opt.model} className="text-[12px] font-mono">
                  {shortModel(opt.model)} ({opt.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>

        {/* Effort filter — shown only when one model selected with 2+ tiers */}
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
              <SelectTrigger id="runs-effort-filter" size="sm" className="h-7 w-[100px] bg-muted/40 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any" className="text-[12px]">Any</SelectItem>
                {effortOptions.map((e) => (
                  <SelectItem key={e.effort} value={e.effort} className="text-[12px]">
                    {e.effort} ({e.count})
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
            value={urlSince ?? "all"}
            onValueChange={(v) => updateUrl({ since: v === "all" ? null : v, page: null })}
          >
            <SelectTrigger id="runs-date-filter" size="sm" className="h-7 w-[90px] bg-muted/40 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-[12px]">All time</SelectItem>
              <SelectItem value="1h" className="text-[12px]">1 hour</SelectItem>
              <SelectItem value="24h" className="text-[12px]">24 hours</SelectItem>
              <SelectItem value="7d" className="text-[12px]">7 days</SelectItem>
              <SelectItem value="30d" className="text-[12px]">30 days</SelectItem>
            </SelectContent>
          </Select>
        </label>

        <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">{totalCount}</span> runs
          </span>
        </div>
      </div>
    </div>
  );
}
