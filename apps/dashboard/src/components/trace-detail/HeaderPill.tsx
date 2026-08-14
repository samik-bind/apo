"use client";

export function HeaderPill({
  children,
  mono = false,
}: {
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <span className={`inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-xs text-muted-foreground ${mono ? "font-mono" : ""}`}>
      {children}
    </span>
  );
}
