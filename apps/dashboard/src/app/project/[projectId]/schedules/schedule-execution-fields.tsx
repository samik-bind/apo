"use client";

import { ExecutorPoolSelect } from "@/components/executor-pool-select";
import type { ExecutorPoolSummary } from "@/lib/executor-api";

interface ScheduleExecutionFieldsProps {
  executorPools: ExecutorPoolSummary[];
  executorPoolId: string;
  queueTtlSeconds: number;
  onExecutorPoolChange: (poolId: string) => void;
  onQueueTtlChange: (seconds: number) => void;
}

export function ScheduleExecutionFields({
  executorPools,
  executorPoolId,
  queueTtlSeconds,
  onExecutorPoolChange,
  onQueueTtlChange,
}: ScheduleExecutionFieldsProps) {
  return (
    <>
      <div className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
        <ExecutorPoolSelect
          id="schedule-executor-pool"
          pools={executorPools}
          value={executorPoolId}
          onValueChange={onExecutorPoolChange}
        />
        <div className="space-y-1.5">
          <label htmlFor="schedule-queue-ttl" className="text-xs font-medium">
            Queue timeout
          </label>
          <select
            id="schedule-queue-ttl"
            value={queueTtlSeconds}
            onChange={(event) => onQueueTtlChange(Number(event.target.value))}
            className="flex h-8 w-full border border-input bg-transparent px-2.5 text-[12px] outline-none focus:border-ring"
          >
            <option value={3600}>1 hour</option>
            <option value={21_600}>6 hours</option>
            <option value={86_400}>24 hours</option>
            <option value={604_800}>7 days</option>
          </select>
        </div>
      </div>
      {!executorPoolId && (
        <p className="text-[12px] text-muted-foreground">
          Choose where scheduled runs should execute. Apo will not silently use a different pool.
        </p>
      )}
    </>
  );
}
