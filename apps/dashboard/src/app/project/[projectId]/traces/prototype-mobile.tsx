"use client";

/**
 * PROTOTYPE — THROWAWAY. Do not build on this file.
 *
 * Question: "What should mobile traces look like?" — not "how do we squeeze
 * the desktop table", but which mobile-native shape fits the phone job
 * (monitor / triage / search, deep analysis stays on desktop).
 *
 * Three structurally different variants on this route behind ?variant=:
 *   A "Compact table" — trimmed table + active-filter chip row + bottom sheet
 *   B "Triage feed"   — status-first card feed + segmented All/Failed/Starred
 *   C "Search first"  — search is the screen; one-line rows expand inline
 *
 * Real data, real URL filters, read-only. Switch variants with the floating
 * bar at the bottom (or ←/→ keys). Once a variant wins, fold it into
 * TracesTablePanel / TracesPageLayout properly and delete this file plus the
 * gate in page.tsx / traces-page-client.tsx. Verdict: PROTOTYPE-NOTES.md.
 */

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Search,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useSelection } from "@/components/trace-detail";
import type { TraceFilterOptions } from "@/components/trace-filter-controls";
import type { TraceSummary, TraceMetric } from "@/lib/traces-api";
import { formatInterval, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export type PrototypeVariant = "A" | "B" | "C";

const VARIANT_META: Record<PrototypeVariant, { name: string }> = {
  A: { name: "Compact table" },
  B: { name: "Triage feed" },
  C: { name: "Search first" },
};

interface PrototypeProps {
  variant: PrototypeVariant;
  projectId: string;
  traces: TraceSummary[];
  error?: string | null;
  filterOptions?: TraceFilterOptions;
}

/* ---------------------------------------------------------------- helpers */

/** Change URL filter params without losing ?variant= (the prototype gate). */
function useUpdateParams() {
  const router = useRouter();
  const pathname = usePathname();
  return (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(window.location.search);
    mutate(params);
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`);
  };
}

function StatusIcon({ trace }: { trace: TraceSummary }) {
  if (trace.error_count > 0)
    return <AlertCircle className="size-4 shrink-0 text-destructive" />;
  if (trace.warning_count > 0)
    return <AlertTriangle className="size-4 shrink-0 text-warning" />;
  return <CheckCircle2 className="size-4 shrink-0 text-[var(--success)]" />;
}

function traceTitle(trace: TraceSummary): string {
  return trace.task_id?.split("/").pop() || trace.input_preview || trace.id;
}

function metric(metrics: TraceMetric[], name: string): number | null {
  return metrics.find((m) => m.metric_name === name)?.score ?? null;
}

function SearchBox({ initial }: { initial: string }) {
  const updateParams = useUpdateParams();
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex items-center gap-2 px-4 pb-2"
      onSubmit={(e) => {
        e.preventDefault();
        updateParams((p) => {
          if (value.trim()) p.set("search", value.trim());
          else p.delete("search");
        });
      }}
    >
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search traces…"
          aria-label="Search traces"
          className="h-9 w-full border-border pl-8 text-xs"
        />
      </div>
      <Button type="submit" size="sm" className="h-9 px-3 text-xs">
        Go
      </Button>
    </form>
  );
}

function EmptyOrError({ traces, error }: { traces: TraceSummary[]; error?: string | null }) {
  if (error) return <p className="px-4 py-8 text-center text-xs text-destructive">{error}</p>;
  if (traces.length === 0)
    return (
      <p className="px-4 py-8 text-center text-xs text-muted-foreground">
        No traces match the current filters.
      </p>
    );
  return null;
}

/* ------------------------------------------------- active-filter chip row */

interface FilterChip {
  key: string;
  label: string;
  remove: (p: URLSearchParams) => void;
}

function activeChips(params: URLSearchParams): FilterChip[] {
  const chips: FilterChip[] = [];
  const add = (key: string, label: string, remove: (p: URLSearchParams) => void) =>
    chips.push({ key, label, remove });

  const status = params.get("status");
  if (status) add("status", `Status: ${status}`, (p) => p.delete("status"));

  const env = params.get("environment");
  if (env) add("env", `Env: ${env}`, (p) => p.delete("environment"));

  const taskId = params.get("task_id");
  if (taskId) add("task", `Task: ${taskId}`, (p) => p.delete("task_id"));

  const sessionId = params.get("session_id");
  if (sessionId) add("session", `Session: ${sessionId.slice(0, 8)}`, (p) => p.delete("session_id"));

  for (const model of (params.get("models") ?? "").split(",").filter(Boolean)) {
    add(`model:${model}`, model, (p) => {
      const rest = (params.get("models") ?? "").split(",").filter((m) => m !== model);
      if (rest.length) p.set("models", rest.join(","));
      else p.delete("models");
    });
  }
  for (const tag of (params.get("tags") ?? "").split(",").filter(Boolean)) {
    add(`tag:${tag}`, `#${tag}`, (p) => {
      const rest = (params.get("tags") ?? "").split(",").filter((t) => t !== tag);
      if (rest.length) p.set("tags", rest.join(","));
      else p.delete("tags");
    });
  }

  const tp = params.get("timePreset");
  if (tp && tp !== "all")
    add("time", `Last ${tp}`, (p) => {
      p.delete("timePreset");
      p.delete("created_after");
      p.delete("created_before");
    });

  const min = params.get("min_duration_ms");
  const max = params.get("max_duration_ms");
  if (min || max)
    add("dur", `${min ?? "0"}–${max ?? "∞"} ms`, (p) => {
      p.delete("min_duration_ms");
      p.delete("max_duration_ms");
    });

  return chips;
}

function FilterChipRow({
  chips,
  onOpenSheet,
  showSheetButton = true,
}: {
  chips: FilterChip[];
  onOpenSheet: () => void;
  showSheetButton?: boolean;
}) {
  const updateParams = useUpdateParams();
  if (chips.length === 0 && !showSheetButton) return null;
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-2">
      {showSheetButton && (
        <button
          type="button"
          onClick={onOpenSheet}
          className="flex h-8 shrink-0 items-center gap-1.5 border border-border bg-card px-2.5 text-xs font-medium text-foreground"
        >
          <ListFilter className="size-3.5" />
          Filters
          {chips.length > 0 && (
            <span className="grid size-4 place-items-center bg-foreground text-[10px] font-semibold text-background">
              {chips.length}
            </span>
          )}
        </button>
      )}
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          onClick={() => updateParams(chip.remove)}
          className="flex h-8 shrink-0 items-center gap-1 border border-border bg-muted/40 px-2 text-[11px] text-foreground whitespace-nowrap"
        >
          <span className="max-w-32 truncate">{chip.label}</span>
          <X className="size-3 text-muted-foreground" />
        </button>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={() =>
            updateParams((p) => {
              chips.forEach((c) => c.remove(p));
            })
          }
          className="h-8 shrink-0 px-2 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

/* --------------------------------------------- bottom-sheet filter sheet */

const TIME_PRESETS = ["all", "1h", "24h", "7d", "30d"] as const;
const DURATION_PRESETS = [
  { label: "Any", min: "", max: "" },
  { label: "< 1s", min: "", max: "1000" },
  { label: "1–10s", min: "1000", max: "10000" },
  { label: "10–60s", min: "10000", max: "60000" },
  { label: "> 60s", min: "60000", max: "" },
];

function FilterSheet({
  open,
  onOpenChange,
  params,
  filterOptions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: URLSearchParams;
  filterOptions?: TraceFilterOptions;
}) {
  const updateParams = useUpdateParams();
  const apply = (mutate: (p: URLSearchParams) => void) => updateParams(mutate);

  const setTimePreset = (preset: string) =>
    apply((p) => {
      p.set("timePreset", preset);
      p.delete("created_after");
      p.delete("created_before");
      if (preset !== "all") {
        const hours = preset === "1h" ? 1 : preset === "24h" ? 24 : preset === "7d" ? 168 : 720;
        p.set("created_after", new Date(Date.now() - hours * 3600_000).toISOString());
      }
    });

  const setDuration = (min: string, max: string) =>
    apply((p) => {
      if (min) p.set("min_duration_ms", min);
      else p.delete("min_duration_ms");
      if (max) p.set("max_duration_ms", max);
      else p.delete("max_duration_ms");
    });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto p-0">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="text-sm">Filters</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 p-4">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Time</p>
            <div className="flex flex-wrap gap-1.5">
              {TIME_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setTimePreset(preset)}
                  className={cn(
                    "h-9 min-w-14 border px-3 text-xs",
                    (params.get("timePreset") ?? "all") === preset
                      ? "border-foreground bg-foreground font-medium text-background"
                      : "border-border bg-card text-foreground",
                  )}
                >
                  {preset === "all" ? "All" : preset}
                </button>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Duration</p>
            <div className="flex flex-wrap gap-1.5">
              {DURATION_PRESETS.map((d) => {
                const active =
                  (params.get("min_duration_ms") ?? "") === d.min &&
                  (params.get("max_duration_ms") ?? "") === d.max;
                return (
                  <button
                    key={d.label}
                    type="button"
                    onClick={() => setDuration(d.min, d.max)}
                    className={cn(
                      "h-9 border px-3 text-xs",
                      active
                        ? "border-foreground bg-foreground font-medium text-background"
                        : "border-border bg-card text-foreground",
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Status</p>
              <Select
                value={params.get("status") ?? "any"}
                onValueChange={(v) => apply((p) => (v === "any" ? p.delete("status") : p.set("status", v)))}
              >
                <SelectTrigger className="h-9 w-full text-xs" aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="ok">OK</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Environment</p>
              <Select
                value={params.get("environment") ?? "any"}
                onValueChange={(v) =>
                  apply((p) => (v === "any" ? p.delete("environment") : p.set("environment", v)))
                }
              >
                <SelectTrigger className="h-9 w-full text-xs" aria-label="Environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  <SelectItem value="default">default</SelectItem>
                  <SelectItem value="dev">dev</SelectItem>
                  <SelectItem value="staging">staging</SelectItem>
                  <SelectItem value="production">production</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {filterOptions?.models && filterOptions.models.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Model</p>
              <Select
                value={params.get("models") ?? "any"}
                onValueChange={(v) => apply((p) => (v === "any" ? p.delete("models") : p.set("models", v)))}
              >
                <SelectTrigger className="h-9 w-full text-xs" aria-label="Model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {filterOptions.models.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Button
            type="button"
            variant="outline"
            className="h-9 w-full text-xs"
            onClick={() =>
              apply((p) => {
                ["status", "environment", "models", "tags", "timePreset", "created_after",
                  "created_before", "min_duration_ms", "max_duration_ms", "task_id", "session_id",
                ].forEach((k) => p.delete(k));
              })
            }
          >
            Reset filters
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ------------------------------------------------------- variant A: table */

function VariantA({ traces, error, filterOptions }: Omit<PrototypeProps, "variant" | "projectId">) {
  const params = useSearchParams();
  const chips = activeChips(params);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { selectRun } = useSelection();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border bg-background pb-2 pt-3">
        <div className="flex items-baseline justify-between px-4 pb-2">
          <h1 className="text-sm font-semibold">Traces</h1>
          <span className="text-[11px] text-muted-foreground">{traces.length} on this page</span>
        </div>
        <SearchBox initial={params.get("search") ?? ""} />
        <FilterChipRow chips={chips} onOpenSheet={() => setSheetOpen(true)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyOrError traces={traces} error={error} />
        <div className="grid grid-cols-[minmax(0,1fr)_64px_56px] gap-2 border-b border-border bg-muted/20 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>Trace</span>
          <span className="text-right">Duration</span>
          <span className="text-right">When</span>
        </div>
        {traces.map((trace) => (
          <button
            key={trace.id}
            type="button"
            onClick={() => selectRun(trace.id)}
            className="grid w-full grid-cols-[minmax(0,1fr)_64px_56px] items-center gap-2 border-b border-border/50 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
          >
            <span className="flex min-w-0 items-center gap-2">
              <StatusIcon trace={trace} />
              <span className="truncate text-xs text-foreground">{traceTitle(trace)}</span>
              {trace.error_count > 0 && (
                <span className="shrink-0 font-mono text-[10px] text-destructive">{trace.error_count}</span>
              )}
            </span>
            <span className="text-right font-mono text-xs tabular-nums text-muted-foreground">
              {formatInterval(trace.duration_ms)}
            </span>
            <span className="text-right text-[11px] text-muted-foreground">
              {formatRelativeTime(trace.created_at)}
            </span>
          </button>
        ))}
      </div>
      <FilterSheet open={sheetOpen} onOpenChange={setSheetOpen} params={params} filterOptions={filterOptions} />
    </div>
  );
}

/* --------------------------------------------------- variant B: card feed */

function VariantB({ traces, error, filterOptions }: Omit<PrototypeProps, "variant" | "projectId">) {
  const params = useSearchParams();
  const updateParams = useUpdateParams();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { selectRun } = useSelection();
  const chips = activeChips(params);

  const segment = params.get("status") === "error" ? "failed" : params.get("bookmarked") === "true" ? "starred" : "all";
  const setSegment = (next: "all" | "failed" | "starred") =>
    updateParams((p) => {
      p.delete("status");
      p.delete("bookmarked");
      if (next === "failed") p.set("status", "error");
      if (next === "starred") p.set("bookmarked", "true");
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border bg-background pb-2 pt-3">
        <div className="flex items-center gap-2 px-4">
          <h1 className="flex-1 text-sm font-semibold">Traces</h1>
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            aria-label="More filters"
            className="flex size-8 items-center justify-center border border-border bg-card text-muted-foreground"
          >
            <ListFilter className="size-4" />
          </button>
        </div>
        <div className="flex px-4">
          {(["all", "failed", "starred"] as const).map((seg) => (
            <button
              key={seg}
              type="button"
              onClick={() => setSegment(seg)}
              className={cn(
                "h-9 flex-1 border text-xs font-medium capitalize transition-colors",
                seg === "all" ? "border-r-0" : seg === "failed" ? "border-x-0" : "",
                segment === seg
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground",
              )}
            >
              {seg}
            </button>
          ))}
        </div>
        <SearchBox initial={params.get("search") ?? ""} />
        <FilterChipRow chips={chips} onOpenSheet={() => setSheetOpen(true)} showSheetButton={false} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyOrError traces={traces} error={error} />
        {traces.map((trace) => (
          <button
            key={trace.id}
            type="button"
            onClick={() => selectRun(trace.id)}
            className="block w-full border-b border-border/50 px-4 py-3 text-left transition-colors hover:bg-muted/30"
          >
            <div className="flex items-center gap-2">
              <StatusIcon trace={trace} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                {traceTitle(trace)}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {formatInterval(trace.duration_ms)}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              {trace.primary_model && (
                <span className="border border-border/60 bg-muted/30 px-1.5 py-0.5">{trace.primary_model}</span>
              )}
              <span className="font-mono">{trace.call_count} calls</span>
              {trace.error_count > 0 && (
                <span className="font-mono text-destructive">{trace.error_count} errors</span>
              )}
              <span className="ml-auto">{formatRelativeTime(trace.created_at)}</span>
            </div>
          </button>
        ))}
      </div>
      <FilterSheet open={sheetOpen} onOpenChange={setSheetOpen} params={params} filterOptions={filterOptions} />
    </div>
  );
}

/* ----------------------------------------------- variant C: search first */

function VariantC({ traces, error, filterOptions }: Omit<PrototypeProps, "variant" | "projectId">) {
  const params = useSearchParams();
  const chips = activeChips(params);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { selectRun } = useSelection();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border bg-background pb-2 pt-3">
        <SearchBox initial={params.get("search") ?? ""} />
        <FilterChipRow chips={chips} onOpenSheet={() => setSheetOpen(true)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyOrError traces={traces} error={error} />
        {traces.map((trace) => {
          const isOpen = expanded === trace.id;
          const tokens = metric(trace.metrics, "total_tokens");
          return (
            <div key={trace.id} className="border-b border-border/50">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : trace.id)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-muted/30"
              >
                <StatusIcon trace={trace} />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{traceTitle(trace)}</span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {formatInterval(trace.duration_ms)}
                </span>
                <ChevronDown
                  className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")}
                />
              </button>
              {isOpen && (
                <div className="space-y-2 px-4 pb-3 pl-10">
                  <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1 text-[11px]">
                    <dt className="text-muted-foreground">Model</dt>
                    <dd className="truncate font-mono text-foreground">{trace.primary_model ?? "—"}</dd>
                    <dt className="text-muted-foreground">Env</dt>
                    <dd className="font-mono text-foreground">{trace.environment}</dd>
                    {tokens !== null && (
                      <>
                        <dt className="text-muted-foreground">Tokens</dt>
                        <dd className="font-mono tabular-nums text-foreground">{tokens.toLocaleString()}</dd>
                      </>
                    )}
                    {trace.tags.length > 0 && (
                      <>
                        <dt className="text-muted-foreground">Tags</dt>
                        <dd className="truncate font-mono text-foreground">{trace.tags.join(", ")}</dd>
                      </>
                    )}
                    <dt className="text-muted-foreground">When</dt>
                    <dd className="text-foreground">{formatRelativeTime(trace.created_at)}</dd>
                  </dl>
                  <Button type="button" size="sm" className="h-8 text-xs" onClick={() => selectRun(trace.id)}>
                    Open trace
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <FilterSheet open={sheetOpen} onOpenChange={setSheetOpen} params={params} filterOptions={filterOptions} />
    </div>
  );
}

/* ------------------------------------------------------- switcher + mount */

export function PrototypeVariantBar({ current }: { current: PrototypeVariant }) {
  const router = useRouter();
  const pathname = usePathname();

  const cycle = (dir: 1 | -1) => {
    const order: PrototypeVariant[] = ["A", "B", "C"];
    const next = order[(order.indexOf(current) + dir + order.length) % order.length];
    const params = new URLSearchParams(window.location.search);
    params.set("variant", next);
    router.replace(`${pathname}?${params.toString()}`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable) return;
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-3 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-1 border border-border bg-popover px-1.5 py-1 text-xs shadow-xl">
      <button
        type="button"
        onClick={() => cycle(-1)}
        aria-label="Previous variant"
        className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-32 text-center font-medium">
        {current} · {VARIANT_META[current].name}
      </span>
      <button
        type="button"
        onClick={() => cycle(1)}
        aria-label="Next variant"
        className="flex size-7 items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  );
}

export function TracesMobilePrototype({
  variant,
  projectId,
  traces,
  error,
  filterOptions,
}: PrototypeProps) {
  const props = { traces, error, filterOptions };
  return (
    <div className="relative h-full w-full" data-prototype={variant} data-project={projectId}>
      {variant === "A" && <VariantA {...props} />}
      {variant === "B" && <VariantB {...props} />}
      {variant === "C" && <VariantC {...props} />}
      <PrototypeVariantBar current={variant} />
    </div>
  );
}
