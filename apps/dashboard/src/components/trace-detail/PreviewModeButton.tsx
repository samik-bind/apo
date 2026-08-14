"use client";

export function PreviewModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={active
        ? "border border-border/80 bg-muted/10 px-1.5 py-0.5 text-xs text-foreground"
        : "px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"}
    >
      {children}
    </button>
  );
}
