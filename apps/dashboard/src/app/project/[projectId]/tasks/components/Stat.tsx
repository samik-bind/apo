"use client";

import type { ComponentType } from "react";

export function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      <Icon className="h-3.5 w-3.5 text-muted-foreground/60" />
      <span className="text-muted-foreground/60">{label}</span>
      <span className="font-mono tabular-nums text-foreground/70">{value}</span>
    </div>
  );
}
