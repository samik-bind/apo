"use client";

import { Checkbox } from "@/components/ui/checkbox";

// Root-level select-all for the folder list. Operates on the same visible
// task set as the folder checkboxes below it (respects search + status
// filters), so with no filters it is "every task in the project".
export function SelectAllRow({
  state,
  taskCount,
  onToggle,
}: {
  state: "none" | "some" | "all";
  taskCount: number;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-2 py-2">
      <Checkbox
        checked={state === "all" ? true : state === "some" ? "indeterminate" : false}
        onCheckedChange={onToggle}
        aria-label="Select all tasks"
      />
      <span className="font-mono text-[13px] font-medium text-muted-foreground">All tasks</span>
      <span className="bg-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
        {taskCount} tasks
      </span>
    </div>
  );
}
