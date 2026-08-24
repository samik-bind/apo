"use client";

import { useRouter } from "next/navigation";
import { useRunEvents, RunEvent } from "@/hooks/use-run-events";

interface TaskRunAutoRefreshProps {
  project: string;
  taskRunId: string;
  isRunning: boolean;
}

export function TaskRunAutoRefresh({
  project,
  taskRunId,
  isRunning,
}: TaskRunAutoRefreshProps) {
  const router = useRouter();

  const handleEvent = (event: RunEvent) => {
    if (
      (event.event_type === "task_run.completed" ||
        event.event_type === "task_run.error") &&
      event.data.task_run_id === taskRunId
    ) {
      router.refresh();
    }
  };

  useRunEvents({
    project,
    enabled: isRunning,
    onEvent: handleEvent,
    // A drop is a window this run's terminal event may have fallen into —
    // it is never replayed, so re-fetch the page state on reconnect.
    onReconnect: () => router.refresh(),
  });

  return null;
}
