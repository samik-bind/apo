"use client";

export function MetadataRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <div className="text-xs text-muted-foreground">
        {label}
      </div>
      <div className="text-right text-sm text-foreground">{value}</div>
    </div>
  );
}
