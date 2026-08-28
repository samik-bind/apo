"use client";

// PROTOTYPE (see shared.tsx) — Variant C: status front and center, rest tucked away.
// Status is the most-used dimension, so it gets a single-select segmented
// control that is always visible; model/effort/date collapse into one "Scope"
// menu with a count badge instead of chips. The most compact bar, and it
// deliberately changes the interaction model to single-select — the question
// it probes is whether multi-select status is actually worth its width.

import { type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

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
  PrototypeSearch,
  SinceMenuRows,
  menuSectionLabel,
  type PrototypeFilterProps,
} from "./shared";

function SegButton({
  active,
  onClick,
  dot,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  dot?: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 border-l border-border px-2.5 text-[12px] transition-colors first:border-l-0",
        active
          ? "bg-foreground/[0.12] font-medium text-foreground"
          : "text-muted-foreground hover:bg-muted/60",
      )}
    >
      {dot && <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />}
      {children}
      {count !== undefined && (
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground/60">{count}</span>
      )}
    </button>
  );
}

export function VariantC(props: PrototypeFilterProps) {
  const single = props.status.size === 1 ? Array.from(props.status)[0] ?? null : null;
  const scopeCount = (props.model ? 1 : 0) + (props.effort ? 1 : 0) + (props.since ? 1 : 0);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-stretch border border-input bg-muted/40">
        <SegButton active={single === null} onClick={() => props.onStatusChange(new Set())}>
          All
        </SegButton>
        {props.statusOptions.map((opt) => (
          <SegButton
            key={opt.value}
            active={single === opt.value}
            dot={opt.dot}
            count={opt.count}
            onClick={() =>
              props.onStatusChange(single === opt.value ? new Set() : new Set([opt.value]))
            }
          >
            {opt.label}
          </SegButton>
        ))}
      </div>

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
            aria-label="Scope filters (model, effort, date)"
            className={cn(
              "flex h-7 items-center gap-1.5 border px-2 text-[12px] transition-colors",
              scopeCount > 0
                ? "border-foreground/30 bg-muted/60 text-foreground"
                : "border-input bg-muted/40 text-muted-foreground hover:bg-muted/60",
            )}
          >
            Scope
            {scopeCount > 0 && (
              <span className="border border-foreground/25 bg-foreground/10 px-1 font-mono text-[10px] tabular-nums">
                {scopeCount}
              </span>
            )}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[18rem] max-h-[26rem] overflow-y-auto">
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
          {props.onClearAll && (scopeCount > 0 || single !== null) && (
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
  );
}
