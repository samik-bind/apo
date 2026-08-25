"use client";

/**
 * Markdown deliverable viewer — the deliverables-tab counterpart to
 * `ExpandableJson` (objects) and `ShikiCodeBlock` (plain text).
 *
 * Markdown-looking string bodies render with the shared `Markdown`
 * component, the same renderer the rest of the dashboard uses (judge
 * values, transcripts, reasoning). A Rendered/Source toggle keeps the raw
 * text one click away — this is an eval tool; graders diff the source.
 */

import { useState } from "react";
import { Markdown } from "@/components/trace-detail/Markdown";
import { cn } from "@/lib/utils";

export function DeliverableMarkdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [source, setSource] = useState(false);

  return (
    <div className={cn("overflow-hidden", className)}>
      <div className="flex items-center justify-between border-b border-border/50 bg-card px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          markdown
        </span>
        <div className="flex items-center gap-0.5" role="group" aria-label="Markdown view mode">
          {(
            [
              { label: "Rendered", active: !source, select: () => setSource(false) },
              { label: "Source", active: source, select: () => setSource(true) },
            ] as const
          ).map((mode) => (
            <button
              key={mode.label}
              type="button"
              aria-pressed={mode.active}
              onClick={mode.select}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                mode.active
                  ? "bg-foreground/10 text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>
      {source ? (
        <pre className="overflow-x-auto whitespace-pre px-4 py-3 font-mono text-[13px] leading-[1.6] text-foreground">
          {text}
        </pre>
      ) : (
        <div className="px-4 py-3">
          <Markdown className="text-[13px]">{text}</Markdown>
        </div>
      )}
    </div>
  );
}
