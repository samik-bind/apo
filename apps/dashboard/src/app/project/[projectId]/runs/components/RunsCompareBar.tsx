"use client";

import Link from "next/link";
import { GitCompare } from "lucide-react";

import { type AgentTaskBatchRunSummary } from "@/lib/agent-task-api";
import { Button } from "@/components/ui/button";

import { getBatchName, type TaskOverlap } from "./runs-utils";

interface RunsCompareBarProps {
  compareIds: string[];
  compareBatches: (AgentTaskBatchRunSummary | null)[];
  overlap: TaskOverlap | null;
  projectId: string;
  onClearCompare: () => void;
}

/**
 * Sticky bottom bar shown while runs are selected for comparison. Rendered
 * by the parent only when `compareIds` is non-empty.
 */
export function RunsCompareBar({ compareIds, compareBatches, overlap, projectId, onClearCompare }: RunsCompareBarProps) {
  return (
    <div className="sticky bottom-4 z-20 mx-auto mb-4 w-fit">
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 shadow-2xl shadow-black/60">
        <GitCompare className="h-4 w-4 text-muted-foreground" />
        <div className="flex items-center gap-2 text-[12px]">
          {compareIds.map((id, i) => {
            const batch = compareBatches[i];
            return (
              <span key={id} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-muted-foreground/40">vs</span>}
                <span className="rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {batch ? getBatchName(batch) : id.slice(0, 8)}
                </span>
              </span>
            );
          })}
          {compareIds.length === 2 && (
            <span className="text-muted-foreground">
              {overlap ? (
                overlap.shared === 0 ? (
                  <span className="text-muted-foreground/70">no shared tasks</span>
                ) : (
                  <>
                    <span className="font-mono tabular-nums text-foreground">{overlap.shared}</span> shared
                    {overlap.onlyA > 0 && (
                      <> {"\u00b7"} <span className="font-mono tabular-nums">{overlap.onlyA}</span> only A</>
                    )}
                    {overlap.onlyB > 0 && (
                      <> {"\u00b7"} <span className="font-mono tabular-nums">{overlap.onlyB}</span> only B</>
                    )}
                  </>
                )
              ) : (
                <span className="text-muted-foreground/60">
                  {compareBatches[0] && compareBatches[1] ? "overlap unknown" : "select both on one page"}
                </span>
              )}
            </span>
          )}
        </div>
        <div className="h-5 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[12px] font-normal text-muted-foreground hover:text-foreground"
          onClick={onClearCompare}
        >
          Clear
        </Button>
        {compareIds.length === 2 && overlap !== null && overlap.shared === 0 ? (
          <span className="text-[12px] text-muted-foreground/70">Nothing to compare</span>
        ) : compareIds.length === 2 ? (
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 px-3 text-[12px] font-medium"
            asChild
          >
            <Link href={`/project/${projectId}/runs/compare?a=${compareIds[0]}&b=${compareIds[1]}`}>
              Compare
            </Link>
          </Button>
        ) : (
          <span className="text-[12px] text-muted-foreground">Select one more</span>
        )}
      </div>
    </div>
  );
}
