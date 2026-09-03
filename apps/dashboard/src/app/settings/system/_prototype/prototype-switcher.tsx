"use client";

// PROTOTYPE — floating variant switcher for the System settings IA
// prototype (see ./NOTES.md). Cycles ?variant= on /settings/system via
// ◀ ▶ buttons and the ← → arrow keys. Dev-only: the page only mounts this
// when NODE_ENV !== "production" and a ?variant= param is present.

import { useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PROTOTYPE_VARIANTS } from "./variant-keys";

export function PrototypeSwitcher({ current }: { current: string }) {
  const router = useRouter();
  const index = Math.max(
    0,
    PROTOTYPE_VARIANTS.findIndex((variant) => variant.key === current),
  );

  const go = useCallback(
    (direction: 1 | -1) => {
      const next =
        PROTOTYPE_VARIANTS[
          (index + direction + PROTOTYPE_VARIANTS.length) %
            PROTOTYPE_VARIANTS.length
        ];
      router.replace(`/settings/system?variant=${next.key}`, {
        scroll: false,
      });
    },
    [index, router],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go]);

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 border border-border bg-popover px-2 py-1 shadow-xl">
      <span className="px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Prototype
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Previous variant"
        onClick={() => go(-1)}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <span className="min-w-56 select-none px-1 text-center text-xs font-medium whitespace-nowrap">
        {PROTOTYPE_VARIANTS[index].label}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Next variant"
        onClick={() => go(1)}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
