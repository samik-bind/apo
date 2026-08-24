import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  Clock,
  Loader2,
  XCircle,
} from "lucide-react";

import type { AgentTaskRunStatus, WireStatus } from "@/lib/agent-task-api";

export type TaskRunStatus = AgentTaskRunStatus;

export interface TaskRunStatusConfig {
  label: string;
  dot: string;
  text: string;
  Icon: React.ComponentType<{ className?: string }>;
}

export const TASK_RUN_STATUS: Record<
  TaskRunStatus,
  TaskRunStatusConfig
> = {
  passed: { label: "Passed", dot: "bg-success", text: "text-success", Icon: CheckCircle2 },
  failed: { label: "Failed", dot: "bg-destructive", text: "text-destructive", Icon: XCircle },
  running: { label: "Running", dot: "bg-foreground animate-pulse", text: "text-muted-foreground", Icon: Loader2 },
  error: { label: "Error", dot: "bg-warning", text: "text-warning", Icon: AlertTriangle },
  pending: { label: "Pending", dot: "bg-white/30", text: "text-white/50", Icon: Clock },
};

// Unknown backend statuses render with their raw string as the label. Never
// collapse them to "pending": a drifted status once made a 3-day-old finished
// run show as "Pending" with no hint anything was wrong.
const UNKNOWN_STATUS_CONFIG = {
  dot: "bg-muted-foreground/40",
  text: "text-muted-foreground",
  Icon: CircleHelp,
};

export function taskRunStatusConfig(status: WireStatus): TaskRunStatusConfig {
  const known = TASK_RUN_STATUS[status as TaskRunStatus];
  return known ?? { label: status || "unknown", ...UNKNOWN_STATUS_CONFIG };
}

export function formatTaskRunDuration(start: string | null, end: string | null) {
  if (!start || !end) return "\u2014";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatTaskRunRelativeTime(dateStr: string | null) {
  if (!dateStr) return "\u2014";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
