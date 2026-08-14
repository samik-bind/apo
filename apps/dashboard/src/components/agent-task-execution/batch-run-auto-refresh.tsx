"use client";

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useRunEvents, RunEvent } from "@/hooks/use-run-events";

/**
 * Coalesce SSE-triggered refreshes: router.refresh() re-runs the whole
 * force-dynamic batch page (every task_run summary + attempts), and a busy
 * batch emits bursts of events — K running tasks replay 2 events each on
 * every stream (re)connect, and concurrent completions land together. One
 * refresh per window bounds that to a single re-render per burst.
 */
const REFRESH_COALESCE_MS = 1000;

interface BatchRunAutoRefreshProps {
  project: string;
  batchRunId: string;
  isRunning: boolean;
}

export function BatchRunAutoRefresh({
  project,
  batchRunId,
  isRunning,
}: BatchRunAutoRefreshProps) {
  const router = useRouter();
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  // useCallback with complete deps so the SSE hook receives a stable,
  // never-stale handler identity (it also keeps the latest one in a ref).
  const handleEvent = useCallback(
    (event: RunEvent) => {
      if (event.data.batch_run_id !== batchRunId) return;

      // Refresh on any task or batch event for this batch run. The
      // trace_claimed event fires mid-run when ingestion first links a trace
      // to a task run — without it the live-trace panel never opens while the
      // task is executing (it would stay stuck on "Waiting for spans...").
      if (
        event.event_type === "batch_run.completed" ||
        event.event_type === "batch_run.failed" ||
        event.event_type === "task_run.started" ||
        event.event_type === "task_run.completed" ||
        event.event_type === "task_run.error" ||
        event.event_type === "task_run.trace_claimed"
      ) {
        if (refreshTimerRef.current) return;
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          router.refresh();
        }, REFRESH_COALESCE_MS);
      }
    },
    [batchRunId, router],
  );

  useRunEvents({
    project,
    enabled: isRunning,
    onEvent: handleEvent,
  });

  return null;
}
