"use client";

// PROTOTYPE (see shared.tsx) — floating variant switcher. Bottom-centre pill,
// cycles A/B/C via the ?variant= URL param (shareable, reload-stable) or the
// ←/→ keys. Dev builds only, so a stray merge can never ship it.

import { useCallback, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PROTOTYPE_VARIANTS, VARIANT_NAMES, type PrototypeVariant } from "./shared";

export function PrototypeSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentRaw = searchParams.get("variant") ?? "A";
  const current = (PROTOTYPE_VARIANTS as readonly string[]).includes(currentRaw)
    ? (currentRaw as PrototypeVariant)
    : "A";
  const index = PROTOTYPE_VARIANTS.indexOf(current);

  const cycle = useCallback(
    (step: 1 | -1) => {
      const next =
        PROTOTYPE_VARIANTS[(index + step + PROTOTYPE_VARIANTS.length) % PROTOTYPE_VARIANTS.length];
      const params = new URLSearchParams(searchParams.toString());
      params.set("variant", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [index, pathname, router, searchParams],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 border border-foreground/40 bg-popover px-2 py-1.5 shadow-lg">
      <button
        type="button"
        aria-label="Previous variant"
        onClick={() => cycle(-1)}
        className="grid h-6 w-6 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="min-w-[230px] text-center font-mono text-[11px] text-foreground">
        {current} — {VARIANT_NAMES[current]}
      </span>
      <button
        type="button"
        aria-label="Next variant"
        onClick={() => cycle(1)}
        className="grid h-6 w-6 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <span className="border-l border-border pl-2 font-mono text-[10px] text-muted-foreground/60">←/→</span>
    </div>
  );
}
