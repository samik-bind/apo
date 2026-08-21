import { cn } from "@/lib/utils";

/** Bordered card section with an optional uppercase header label. */
export function Panel({
  title,
  children,
  className,
  padded = true,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn("overflow-hidden border border-border bg-card/60", className)}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-border bg-background/40 px-4 py-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
        </header>
      )}
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}
