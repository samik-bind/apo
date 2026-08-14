"use client";

import { cn } from "@/lib/utils";

export function PassBar({ value, muted }: { value: number; muted?: boolean }) {
  // `muted` means there is genuinely nothing to show (running, no data).
  // `value === 0` is different: it means the task ran and every run failed —
  // a red flag we want to surface as 0%, not hide behind an em-dash. Callers
  // already gate rendering on `total_runs > 0`, so a 0 reaching us always
  // means "ran but all failed", never "never ran".
  if (muted) {
    return <span className="font-mono text-[12px] text-muted-foreground/60">\u2014</span>;
  }
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? "bg-success" : pct < 50 ? "bg-destructive" : "bg-warning";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-12 overflow-hidden rounded-full bg-border">
        <div className={cn("h-full", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-[12px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}
