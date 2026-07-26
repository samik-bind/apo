"use client";

import type { ExecutorPoolSummary } from "@/lib/executor-api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";

interface ExecutorPoolSelectProps {
  pools: ExecutorPoolSummary[];
  value: string;
  onValueChange: (value: string) => void;
  id: string;
  compact?: boolean;
}

export function ExecutorPoolSelect({
  pools,
  value,
  onValueChange,
  id,
  compact = false,
}: ExecutorPoolSelectProps) {
  const selectable = pools.filter((pool) => pool.enabled && !pool.archived);

  return (
    <div className={compact ? "flex items-center gap-2" : "space-y-1.5"}>
      <Label htmlFor={id} className={compact ? "text-[12px] text-muted-foreground" : "text-xs"}>
        Run on
      </Label>
      <Select value={value || undefined} onValueChange={onValueChange}>
        <SelectTrigger
          id={id}
          size="sm"
          className={compact ? "h-8 min-w-44 text-[12px]" : "h-8 w-full text-[12px]"}
          aria-label="Executor pool"
        >
          <SelectValue placeholder="Choose executor pool" />
        </SelectTrigger>
        <SelectContent>
          {selectable.length === 0 ? (
            <SelectItem value="__none" disabled>
              No available pools
            </SelectItem>
          ) : (
            selectable.map((pool) => (
              <SelectItem key={pool.id} value={pool.id}>
                {pool.name} · {pool.health}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
