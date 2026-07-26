"use client";

import type { ExecutorSummary } from "@/lib/executor-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ExecutorList({
  executors,
  poolId,
  canManage,
  busy,
  onRename,
  onRevoke,
}: {
  executors: ExecutorSummary[];
  poolId: string;
  canManage: boolean;
  busy: boolean;
  onRename: (executor: ExecutorSummary) => void;
  onRevoke: (executor: ExecutorSummary) => void;
}) {
  const visible = executors.filter((executor) => executor.pool_id === poolId);

  return (
    <section aria-labelledby="executor-list-heading">
      <h2 id="executor-list-heading" className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        Executors
      </h2>
      {visible.length === 0 ? (
        <div className="border border-border px-4 py-6 text-[12px] text-muted-foreground">
          No enrolled Executors in this pool.
        </div>
      ) : (
        <div className="divide-y divide-border border border-border">
          {visible.map((executor) => (
            <div key={executor.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px] font-medium">
                  <span className={cn("h-1.5 w-1.5 rounded-full", statusDot(executor.status))} />
                  {executor.name}
                  <span className="text-[10px] uppercase text-muted-foreground">{executor.status}</span>
                </div>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  v{executor.executor_version} · protocol {executor.protocol_version} · {executor.os}/{executor.architecture} · {executor.active_attempts}/{executor.max_concurrency} active
                </p>
              </div>
              {canManage && executor.status !== "disabled" && (
                <div className="flex gap-1.5">
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRename(executor)} className="h-7 text-[11px]">
                    Rename
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onRevoke(executor)} className="h-7 text-[11px] text-destructive">
                    Revoke
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function statusDot(status: string): string {
  if (status === "online") return "bg-success";
  if (status === "busy") return "bg-warning";
  if (status === "disabled") return "bg-destructive";
  return "bg-muted-foreground";
}
