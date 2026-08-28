"use client";

// PROTOTYPE (see shared.tsx) — Variant B: one "Filters" entry point.
// A single menu holds every dimension; active filters are summarized as
// removable chips under the bar. Compact trigger that scales to wide
// vocabularies and extra dimensions; the cost is a click before anything is
// discoverable, and state lives in chips instead of the controls themselves.

import { ChevronDown, ListFilter, X } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import {
  EffortMenuRows,
  ModelMenuRows,
  SinceMenuRows,
  StatusMenuRows,
  PrototypeSearch,
  activeChips,
  countActiveFilters,
  menuSectionLabel,
  toggleStatus,
  type PrototypeFilterProps,
} from "./shared";

export function VariantB(props: PrototypeFilterProps) {
  const chips = activeChips(props);
  const active = countActiveFilters(props);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {props.onQueryChange && (
          <PrototypeSearch
            query={props.query ?? ""}
            onQueryChange={props.onQueryChange}
            placeholder={props.searchPlaceholder}
          />
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Open filters"
              className={cn(
                "flex h-7 items-center gap-1.5 border px-2 text-[12px] transition-colors",
                active > 0
                  ? "border-foreground/30 bg-muted/60 text-foreground"
                  : "border-input bg-muted/40 text-muted-foreground hover:bg-muted/60",
              )}
            >
              <ListFilter className="h-3.5 w-3.5 opacity-70" />
              Filters
              {active > 0 && (
                <span className="border border-foreground/25 bg-foreground/10 px-1 font-mono text-[10px] tabular-nums">
                  {active}
                </span>
              )}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[18rem] max-h-[26rem] overflow-y-auto">
            {menuSectionLabel("Status")}
            <StatusMenuRows
              options={props.statusOptions}
              status={props.status}
              onToggle={(v) => props.onStatusChange(toggleStatus(props.status, v))}
            />
            <DropdownMenuSeparator />
            {menuSectionLabel("Model")}
            <ModelMenuRows
              options={props.modelOptions}
              model={props.model}
              onSelect={props.onModelChange}
            />
            {props.effortOptions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                {menuSectionLabel("Effort")}
                <EffortMenuRows
                  options={props.effortOptions}
                  effort={props.effort}
                  onSelect={props.onEffortChange}
                />
              </>
            )}
            <DropdownMenuSeparator />
            {menuSectionLabel("Date")}
            <SinceMenuRows since={props.since} onSelect={props.onSinceChange} />
            {props.onClearAll && active > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={props.onClearAll} className="text-[12px] text-muted-foreground">
                  Clear all filters
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {props.trailing && (
          <div className="ml-auto flex items-center gap-3 text-[12px] text-muted-foreground">
            {props.trailing}
          </div>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="flex h-6 items-center gap-1.5 border border-foreground/15 bg-muted/40 pl-2 pr-1 text-[11px] text-foreground"
            >
              {chip.dot && <span className={cn("h-2 w-2 rounded-full", chip.dot)} aria-hidden />}
              <span className="text-muted-foreground">{chip.kind}:</span> {chip.label}
              <button
                type="button"
                aria-label={`Remove ${chip.kind.toLowerCase()} filter: ${chip.label}`}
                onClick={chip.onRemove}
                className="grid h-4 w-4 place-items-center text-muted-foreground/60 hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {props.onClearAll && (
            <button
              type="button"
              onClick={props.onClearAll}
              className="text-[11px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
