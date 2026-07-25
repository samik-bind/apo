"use client";

import { ListFilter, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { shortModel } from "@/lib/run-configuration";

export type ModelOption = { model: string; count: number };

/**
 * SPEC-148: a URL-backed multi-select facet for filtering runs by model.
 *
 * Lives on the Execution column header — the model is that column's data, so
 * the filter is discoverable in context. Options are derived from all loaded
 * batch summaries (selecting one value never removes the others from the
 * list). Selection is encoded as a comma-separated `?model=a,b` so a filtered
 * view is shareable. The filter itself (a batch matches when any of its
 * configurations uses a selected model) lives in the parent; this component
 * only reports toggles.
 */
export function RunsModelFilter({
  options,
  selected,
  onToggle,
  onClear,
}: {
  options: ModelOption[];
  selected: Set<string>;
  onToggle: (model: string) => void;
  onClear: () => void;
}) {
  const selectedCount = selected.size;
  const disabled = options.length === 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Filter by model"
          aria-expanded={undefined}
          className={cn(
            "inline-grid h-5 w-5 place-items-center rounded-sm align-middle transition-colors",
            disabled
              ? "cursor-not-allowed text-muted-foreground/30"
              : selectedCount > 0
                ? "bg-foreground text-background"
                : "text-muted-foreground/60 hover:bg-muted hover:text-foreground",
          )}
        >
          <ListFilter className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[16rem]">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Filter by model
        </DropdownMenuLabel>
        <div className="max-h-72 overflow-auto">
          {options.map(({ model, count }) => (
            <DropdownMenuCheckboxItem
              key={model}
              checked={selected.has(model)}
              onCheckedChange={() => onToggle(model)}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="font-mono">{shortModel(model)}</span>
              <span className="ml-auto pl-3 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                {count}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </div>
        {selectedCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onClear} className="gap-1.5 text-muted-foreground">
              <X className="h-3 w-3" />
              Clear filter
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
