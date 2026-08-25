import type { AgentTaskSummary } from "@/lib/agent-task-api";

export type FolderNode = {
  id: string;
  tasks: AgentTaskSummary[];
};

// SPEC-174 evidence views: a tab is a model/effort filter. The Main tab
// (model=null) is permanent and shows all-history; every other tab is a
// closable copy narrowed by model (+ model-aware effort).
export const MAIN_VIEW_ID = "main";

export interface ViewTab {
  id: string;
  label: string;
  model: string | null;  // null = All models (Main)
  effort: string | null; // null = any effort
  since: string | null;  // "7d" | "30d" | "90d" | null (all time)
}

export const STATUS_FILTERS = [
  { key: "passed", label: "Passed", dot: "bg-success" },
  { key: "failed", label: "Failed", dot: "bg-destructive" },
  { key: "errored", label: "Errored", dot: "bg-warning" },
  { key: "idle", label: "Not Run", dot: "bg-muted-foreground/30" },
] as const;
export const STATUS_FILTER_KEYS = STATUS_FILTERS.map((s) => s.key);

export function taskFilterStatus(task: AgentTaskSummary): string {
  const stats = task.run_stats;
  if (!stats || !stats.last_run_status) return "idle";
  if (stats.last_run_status === "error") return "errored";
  if (stats.last_run_status === "running" || stats.last_run_status === "pending") return "running";
  if (stats.last_run_passed === true) return "passed";
  return "failed";
}

export function groupByFolder(tasks: AgentTaskSummary[]): FolderNode[] {
  const groups: Record<string, AgentTaskSummary[]> = {};
  for (const task of tasks) {
    const folder = task.folder_path || "(root)";
    if (!groups[folder]) groups[folder] = [];
    groups[folder].push(task);
  }
  return Object.entries(groups).map(([name, tasks]) => ({ id: name, tasks }));
}

export type TaskStatus = "passed" | "failed" | "running" | "idle";

export function getTaskStatus(task: AgentTaskSummary): TaskStatus {
  const stats = task.run_stats;
  if (!stats || !stats.last_run_status) return "idle";
  if (stats.last_run_status === "running") return "running";
  if (stats.last_run_passed === true) return "passed";
  return "failed";
}

export const STATUS_CONFIG: Record<Exclude<TaskStatus, "idle">, { label: string; dot: string; text: string }> = {
  passed:  { label: "Passed",  dot: "bg-success",              text: "text-success" },
  failed:  { label: "Failed",  dot: "bg-destructive",          text: "text-destructive" },
  running: { label: "Running", dot: "bg-foreground animate-pulse", text: "text-muted-foreground" },
};
