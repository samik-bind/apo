"use client";

// PROTOTYPE (see shared.tsx) — Variant A: everything visible.
// One dense row: search, status as always-visible toggle chips with counts,
// then the model menu and effort/date pickers. Zero clicks to discover any
// filter; the cost is horizontal space when a vocabulary is wide.

import { ModelFilterMenu } from "@/components/model-filter-menu";
import { FilterPicker } from "@/app/project/[projectId]/tasks/components/FilterPicker";
import { ALL_SINCE_VALUE, sinceOptionsFor } from "@/lib/since-window";
import { cn } from "@/lib/utils";

import {
  ProtoModelTrigger,
  PrototypeSearch,
  toggleStatus,
  type PrototypeFilterProps,
} from "./shared";

const ANY_EFFORT_VALUE = "__any__";

export function VariantA(props: PrototypeFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.onQueryChange && (
        <PrototypeSearch
          query={props.query ?? ""}
          onQueryChange={props.onQueryChange}
          placeholder={props.searchPlaceholder}
        />
      )}

      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-[11px] uppercase tracking-wide text-foreground/50">Status</span>
        <div className="flex items-center gap-1">
          {props.statusOptions.map((opt) => {
            const active = props.status.has(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                onClick={() => props.onStatusChange(toggleStatus(props.status, opt.value))}
                className={cn(
                  "flex h-7 items-center gap-1.5 border px-2 text-[12px] transition-colors",
                  active
                    ? "border-foreground/30 bg-muted/60 text-foreground"
                    : "border-input bg-muted/40 text-muted-foreground hover:bg-muted/60",
                )}
              >
                <span className={cn("h-2 w-2 rounded-full", opt.dot)} aria-hidden />
                {opt.label}
                {opt.count !== undefined && (
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">
                    {opt.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <ModelFilterMenu
        options={props.modelOptions}
        selected={props.model ? new Set([props.model]) : new Set()}
        onSelect={props.onModelChange}
        onClear={() => props.onModelChange(null)}
        onSetArchived={props.onSetArchived}
        trigger={<ProtoModelTrigger model={props.model} />}
      />

      {props.effortOptions.length > 0 && (
        <FilterPicker
          label="Effort"
          value={props.effort ?? ANY_EFFORT_VALUE}
          options={[{ value: ANY_EFFORT_VALUE, label: "Any effort" }, ...props.effortOptions]}
          onChange={(v) => props.onEffortChange(v === ANY_EFFORT_VALUE ? null : v)}
        />
      )}

      <FilterPicker
        label="Date"
        value={props.since ?? ALL_SINCE_VALUE}
        options={sinceOptionsFor(props.since)}
        onChange={(v) => props.onSinceChange(v === ALL_SINCE_VALUE ? null : v)}
      />

      {props.onClearAll && (
        <button
          type="button"
          onClick={props.onClearAll}
          className="text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Clear
        </button>
      )}

      {props.trailing && (
        <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
          {props.trailing}
        </div>
      )}
    </div>
  );
}
