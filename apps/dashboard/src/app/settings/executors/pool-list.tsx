"use client";

import { Archive, KeyRound, Pencil, Power, Star } from "lucide-react";
import type { ExecutorPoolSummary } from "@/lib/executor-api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function PoolList({
  pools,
  selectedPoolId,
  canManage,
  canArchive,
  busy,
  onSelect,
  onSetDefault,
  onCreateToken,
  onEdit,
  onToggle,
  onArchive,
}: {
  pools: ExecutorPoolSummary[];
  selectedPoolId: string;
  canManage: boolean;
  canArchive: boolean;
  busy: boolean;
  onSelect: (poolId: string) => void;
  onSetDefault: (pool: ExecutorPoolSummary) => void;
  onCreateToken: (pool: ExecutorPoolSummary) => void;
  onEdit: (pool: ExecutorPoolSummary) => void;
  onToggle: (pool: ExecutorPoolSummary) => void;
  onArchive: (pool: ExecutorPoolSummary) => void;
}) {
  if (pools.length === 0) {
    return (
      <div className="border border-dashed border-border px-5 py-10 text-center">
        <p className="text-[13px] font-medium">No executor pools</p>
        <p className="mt-1 text-[12px] text-muted-foreground">
          Connect an Executor to run dashboard Tasks and schedules in your environment.
          CLI Task runs can still use the caller.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border border border-border">
      {pools.map((pool) => (
        <div
          key={pool.id}
          className={cn("px-3 py-3", selectedPoolId === pool.id && "bg-muted/30")}
        >
          <button
            type="button"
            onClick={() => onSelect(pool.id)}
            className="flex w-full items-start justify-between gap-3 text-left"
            aria-label={`Show Executors in ${pool.name}`}
          >
            <div>
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {pool.name}
                <Badge variant="outline" className="text-[9px] uppercase">{pool.kind}</Badge>
                {pool.is_default && <span className="text-[10px] text-muted-foreground">Default</span>}
              </div>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                {pool.slug} · {pool.online_executor_count} online · {pool.available_capacity} available · TTL {formatTtl(pool.queue_ttl_seconds)}
              </p>
            </div>
            <span className={cn("text-[11px] font-medium uppercase", healthColor(pool.health))}>
              {pool.health}
            </span>
          </button>
          {canManage && !pool.archived && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onEdit(pool)} className="h-7 text-[11px]">
                <Pencil className="mr-1 h-3 w-3" /> Edit
              </Button>
              {!pool.is_default && pool.enabled && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onSetDefault(pool)} className="h-7 text-[11px]">
                  <Star className="mr-1 h-3 w-3" /> Make default
                </Button>
              )}
              {pool.kind === "connected" && pool.enabled && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onCreateToken(pool)} className="h-7 text-[11px]">
                  <KeyRound className="mr-1 h-3 w-3" /> Create token
                </Button>
              )}
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onToggle(pool)} className="h-7 text-[11px]">
                <Power className="mr-1 h-3 w-3" /> {pool.enabled ? "Disable" : "Enable"}
              </Button>
              {canArchive && pool.kind === "connected" && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => onArchive(pool)} className="h-7 text-[11px] text-destructive">
                  <Archive className="mr-1 h-3 w-3" /> Archive
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatTtl(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${seconds}s`;
}

function healthColor(health: ExecutorPoolSummary["health"]): string {
  if (health === "online") return "text-success";
  if (health === "busy" || health === "incompatible") return "text-warning";
  if (health === "disabled") return "text-destructive";
  return "text-muted-foreground";
}
