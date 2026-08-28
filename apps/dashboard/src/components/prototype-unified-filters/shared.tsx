"use client";

// PROTOTYPE — throwaway UI study, not production code.
//
// Question: what should ONE shared filter row look like, so the Tasks list, a
// task's run history, and the Runs page stop shipping three different filter
// UIs for the same dimensions (status / model / effort / date)? Mount with
// ?variant=A|B|C on any of those pages and flip with the floating switcher or
// ←/→. Delete this folder once a direction is picked and folded into a real
// component.
//
// The row is fully controlled: each page keeps owning its state (URL params or
// local) and supplies its own status vocabulary, so the same component can
// speak task status (passed/failed/errored/not-run) and batch status
// (queued/running/completed/partial/…) without knowing either.

import { type ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { visibleModels, type ModelPickerOption } from "@/components/model-filter-menu";
import { shortModel } from "@/lib/run-configuration";
import { ALL_SINCE_VALUE, sinceLabel, sinceOptionsFor } from "@/lib/since-window";
import { cn } from "@/lib/utils";

export const PROTOTYPE_VARIANTS = ["A", "B", "C"] as const;
export type PrototypeVariant = (typeof PROTOTYPE_VARIANTS)[number];

export const VARIANT_NAMES: Record<PrototypeVariant, string> = {
  A: "Flat chips — everything visible",
  B: "Filters menu + active chips",
  C: "Segmented status + Scope menu",
};

export interface PrototypeStatusOption {
  value: string;
  label: string;
  dot: string;
  /** Row/chip count, when the page can compute one. */
  count?: number;
}

export interface PrototypeFilterProps {
  statusOptions: PrototypeStatusOption[];
  status: Set<string>;
  onStatusChange: (next: Set<string>) => void;
  modelOptions: ModelPickerOption[];
  model: string | null;
  onModelChange: (model: string | null) => void;
  onSetArchived?: (model: string, archived: boolean) => void;
  /** Empty hides the effort control (model-aware gating stays in the page). */
  effortOptions: { value: string; label: string }[];
  effort: string | null;
  onEffortChange: (effort: string | null) => void;
  since: string | null;
  onSinceChange: (since: string | null) => void;
  query?: string;
  onQueryChange?: (value: string) => void;
  searchPlaceholder?: string;
  onClearAll?: () => void;
  /** Page-specific right side (result count, expand-all, reset link…). */
  trailing?: ReactNode;
  /** Shown on the state readout line under the row. */
  readoutNote?: string;
}

export function toggleStatus(status: Set<string>, value: string): Set<string> {
  const next = new Set(status);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function countActiveFilters(p: PrototypeFilterProps): number {
  return (
    p.status.size + (p.model ? 1 : 0) + (p.effort ? 1 : 0) + (p.since ? 1 : 0)
  );
}

/** The shared h-7 model trigger (currently copy-pasted at 4 sites in prod). */
export function ProtoModelTrigger({ model }: { model: string | null }) {
  return (
    <button
      type="button"
      aria-label="Model filter"
      className="flex h-7 min-w-[140px] items-center justify-between gap-1 border border-input bg-muted/40 px-2 text-[12px] text-foreground hover:bg-muted/60"
    >
      <span className="truncate font-mono">
        {model ? shortModel(model) : "All models"}
      </span>
      <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
    </button>
  );
}

export function PrototypeSearch({
  query,
  onQueryChange,
  placeholder,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative min-w-[200px] flex-1 max-w-sm">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={placeholder ?? "Filter…"}
        aria-label="Search"
        className="h-8 border-border bg-card pl-8 text-[13px] placeholder:text-muted-foreground/50 focus-visible:border-border"
      />
    </div>
  );
}

// Menu rows shared by the variants that put filters inside a dropdown (B, C).
// Keeping the row rendering shared lets the variants differ in structure, not
// in what a row looks like.

const rowCount = (count: number | undefined) =>
  count !== undefined ? (
    <span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
      {count}
    </span>
  ) : null;

export function StatusMenuRows({
  options,
  status,
  onToggle,
}: {
  options: PrototypeStatusOption[];
  status: Set<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <>
      {options.map((opt) => (
        <DropdownMenuCheckboxItem
          key={opt.value}
          checked={status.has(opt.value)}
          onCheckedChange={() => onToggle(opt.value)}
          onSelect={(e) => e.preventDefault()}
          className="text-[12px]"
        >
          <span className={cn("mr-1.5 inline-block h-2 w-2 rounded-full", opt.dot)} aria-hidden />
          {opt.label}
          {rowCount(opt.count)}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

export function ModelMenuRows({
  options,
  model,
  onSelect,
}: {
  options: ModelPickerOption[];
  model: string | null;
  onSelect: (model: string | null) => void;
}) {
  const selected = model ? new Set([model]) : new Set<string>();
  const visible = visibleModels(options, selected);
  return (
    <>
      <DropdownMenuCheckboxItem
        checked={model === null}
        onCheckedChange={() => onSelect(null)}
        onSelect={(e) => e.preventDefault()}
        className="text-[12px]"
      >
        All models
      </DropdownMenuCheckboxItem>
      {visible.map(({ model: m, count }) => (
        <DropdownMenuCheckboxItem
          key={m}
          checked={model === m}
          onCheckedChange={() => onSelect(m)}
          onSelect={(e) => e.preventDefault()}
          className="text-[12px]"
        >
          <span className="font-mono">{shortModel(m)}</span>
          {rowCount(count)}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

export function EffortMenuRows({
  options,
  effort,
  onSelect,
}: {
  options: { value: string; label: string }[];
  effort: string | null;
  onSelect: (effort: string | null) => void;
}) {
  return (
    <>
      <DropdownMenuCheckboxItem
        checked={effort === null}
        onCheckedChange={() => onSelect(null)}
        onSelect={(e) => e.preventDefault()}
        className="text-[12px]"
      >
        Any effort
      </DropdownMenuCheckboxItem>
      {options.map((opt) => (
        <DropdownMenuCheckboxItem
          key={opt.value}
          checked={effort === opt.value}
          onCheckedChange={() => onSelect(opt.value)}
          onSelect={(e) => e.preventDefault()}
          className="text-[12px]"
        >
          {opt.label}
        </DropdownMenuCheckboxItem>
      ))}
    </>
  );
}

export function SinceMenuRows({
  since,
  onSelect,
}: {
  since: string | null;
  onSelect: (since: string | null) => void;
}) {
  return (
    <>
      {sinceOptionsFor(since).map((opt) => (
        <DropdownMenuItem
          key={opt.value}
          onSelect={(e) => {
            e.preventDefault();
            onSelect(opt.value === ALL_SINCE_VALUE ? null : opt.value);
          }}
          className="text-[12px]"
        >
          <span
            className={cn(
              "mr-2 inline-block h-2 w-2 rounded-full",
              (since ?? ALL_SINCE_VALUE) === opt.value ? "bg-foreground" : "bg-muted-foreground/20",
            )}
            aria-hidden
          />
          {opt.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}

export const menuSectionLabel = (children: ReactNode) => (
  <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
    {children}
  </DropdownMenuLabel>
);

export interface ActiveChip {
  id: string;
  kind: string;
  label: string;
  dot?: string;
  onRemove: () => void;
}

/** One removable chip per active filter, for variants that summarize state. */
export function activeChips(p: PrototypeFilterProps): ActiveChip[] {
  const chips: ActiveChip[] = [];
  for (const opt of p.statusOptions) {
    if (p.status.has(opt.value)) {
      chips.push({
        id: `status:${opt.value}`,
        kind: "Status",
        label: opt.label,
        dot: opt.dot,
        onRemove: () => p.onStatusChange(toggleStatus(p.status, opt.value)),
      });
    }
  }
  if (p.model) {
    chips.push({
      id: "model",
      kind: "Model",
      label: shortModel(p.model),
      onRemove: () => p.onModelChange(null),
    });
  }
  if (p.effort) {
    chips.push({
      id: "effort",
      kind: "Effort",
      label: p.effort,
      onRemove: () => p.onEffortChange(null),
    });
  }
  if (p.since) {
    chips.push({
      id: "since",
      kind: "Date",
      label: sinceLabel(p.since),
      onRemove: () => p.onSinceChange(null),
    });
  }
  return chips;
}
