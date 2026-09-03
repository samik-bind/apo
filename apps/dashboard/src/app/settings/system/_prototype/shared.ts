"use client";

// PROTOTYPE — throwaway data plumbing for the System settings page IA
// prototype (see NOTES.md). Shared across variants because it is data, not
// layout; each variant renders it differently. Do not grow this into a real
// API layer — it dies with the prototype.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { apiClient } from "@/lib/api-client";
import { listProjects, type Project } from "@/lib/projects-api";
import {
  fetchReadinessReport,
  fetchRuntimeConfig,
  fetchTaskRuntimeStatus,
  type AgentTaskRuntimeStatus,
  type ReadinessReport,
  type RuntimeConfig,
} from "@/lib/system-api";

export interface SystemSnapshot {
  config: RuntimeConfig | null;
  readiness: ReadinessReport | null;
  status: AgentTaskRuntimeStatus | null;
}

/** Holds the three read-only system endpoints with one Refresh for all. */
export function useSystemSnapshot(initial: SystemSnapshot) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot>(initial);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [config, readiness, status] = await Promise.allSettled([
      fetchRuntimeConfig(),
      fetchReadinessReport(),
      fetchTaskRuntimeStatus(),
    ]);
    const failed: string[] = [];
    if (config.status === "rejected") failed.push("runtime config");
    if (readiness.status === "rejected") failed.push("readiness");
    if (status.status === "rejected") failed.push("task runtime");
    setSnapshot((prev) => ({
      config: config.status === "fulfilled" ? config.value : prev.config,
      readiness:
        readiness.status === "fulfilled" ? readiness.value : prev.readiness,
      status: status.status === "fulfilled" ? status.value : prev.status,
    }));
    if (failed.length > 0) {
      toast.error(`Failed to refresh: ${failed.join(", ")}`);
    }
    setRefreshing(false);
  }, []);

  return { snapshot, refreshing, refresh };
}

/** Readiness checks plus the task runtime probe, unified into one list. */
export interface HealthCheck {
  key: string;
  name: string;
  ok: boolean;
  detail: string | null;
}

export function collectChecks(snapshot: SystemSnapshot): HealthCheck[] {
  const checks: HealthCheck[] = Object.values(
    snapshot.readiness?.checks ?? {},
  ).map((check) => ({
    key: check.name,
    name: check.name,
    ok: check.ok,
    detail: check.detail,
  }));
  if (snapshot.status) {
    checks.push({
      key: "agent_task_runtime",
      name: "Agent task runtime",
      ok: snapshot.status.available,
      detail: snapshot.status.available
        ? [snapshot.status.node_version, snapshot.status.runner_path]
            .filter(Boolean)
            .join(" · ")
        : snapshot.status.error,
    });
  }
  return checks;
}

/** DB table row counts, loaded on demand (read-only, best-effort). */
export type DbStats = Record<string, number>;

export function useDbStats() {
  const [stats, setStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient<{ stats: DbStats | null }>(
        "/backend-proxy/v1/admin/stats",
        { query: { admin_key: "dev-admin-key-only" } },
      );
      setStats(data.stats);
    } catch {
      setStats(null);
      toast.error("Table counts unavailable — the admin stats call failed");
    } finally {
      setLoading(false);
    }
  }, []);

  return { stats, loading, load };
}

/** Project list for the reset control (read-only). */
export function useProjects(): Project[] {
  const [projects, setProjects] = useState<Project[]>([]);
  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch(() => {});
  }, []);
  return projects;
}

/** Destructive buttons stop here: confirmations are real, the call is not. */
export function runStubbedAction(label: string) {
  toast(`(prototype) ${label} is stubbed — wiring comes after the IA is chosen`);
}
