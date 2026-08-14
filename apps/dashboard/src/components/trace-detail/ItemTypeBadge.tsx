"use client";

export function ItemTypeBadge({ type }: { type?: string | null }) {
  const label = typeof type === "string" && type.length > 0 ? type.toUpperCase() : "SPAN";
  return (
    <span className="inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
  );
}
