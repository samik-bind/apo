"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CheckCircle2, CircleAlert, RefreshCw, XCircle } from "lucide-react";
import {
  fetchReadinessReport,
  fetchRuntimeConfig,
  fetchTaskRuntimeStatus,
  type AgentTaskRuntimeStatus,
  type ReadinessReport,
  type RuntimeConfig,
} from "@/lib/system-api";
import { toast } from "sonner";
import { SystemConfigTable } from "./system-config-table";
import { SystemDataPanel } from "./system-data-panel";
import { SystemMaintenancePanel } from "./system-maintenance-panel";

interface SystemSnapshot {
  config: RuntimeConfig | null;
  readiness: ReadinessReport | null;
  status: AgentTaskRuntimeStatus | null;
}

/**
 * The System settings page: a status-first view of this apo instance.
 *
 * Everything on the page is derived from read-only backend state — an
 * aggregate health verdict up top, then Configuration / Data / Maintenance
 * tabs. Destructive operations live only under Maintenance.
 */
export function SystemOverview({
  initialConfig = null,
  initialReadiness = null,
  initialStatus = null,
}: {
  initialConfig?: RuntimeConfig | null;
  initialReadiness?: ReadinessReport | null;
  initialStatus?: AgentTaskRuntimeStatus | null;
}) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot>({
    config: initialConfig,
    readiness: initialReadiness,
    status: initialStatus,
  });
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

  const checks = collectChecks(snapshot);
  const failing = checks.filter((check) => !check.ok);
  const known = checks.length > 0;
  const allOk = known && failing.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <section className="border bg-card">
        <div className="flex flex-col gap-4 border-b p-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            {allOk ? (
              <CheckCircle2 className="size-5 shrink-0 text-success" />
            ) : known ? (
              <XCircle className="size-5 shrink-0 text-destructive" />
            ) : (
              <CircleAlert className="size-5 shrink-0 text-muted-foreground" />
            )}
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight">
                System
              </h1>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {!known
                  ? "Status unknown — no check has reported yet."
                  : allOk
                    ? `All ${checks.length} checks passing.`
                    : `${failing.length} of ${checks.length} checks failing.`}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={refreshing}
          >
            <RefreshCw className="mr-1.5 size-3.5" />
            Refresh
          </Button>
        </div>

        {failing.length > 0 ? (
          <div className="flex flex-col gap-2 border-b p-6">
            {failing.map((check) => (
              <div
                key={check.key}
                className="flex items-start gap-2 text-[13px]"
              >
                <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <span className="font-medium">{check.name}</span>
                  {check.detail ? (
                    <span className="text-muted-foreground">
                      {" "}
                      — {check.detail}
                    </span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-2 sm:grid-cols-4">
          <QuickFact
            label="Profile"
            value={snapshot.config?.deployment_profile}
            warning={snapshot.config?.deployment_profile === "development"}
          />
          <QuickFact
            label="Scheduler"
            value={
              snapshot.config?.scheduler_enabled === undefined
                ? undefined
                : snapshot.config.scheduler_enabled
                  ? "Enabled"
                  : "Disabled"
            }
            warning={snapshot.config?.scheduler_enabled === false}
          />
          <QuickFact
            label="Database"
            value={snapshot.config?.database.engine}
            warning={
              snapshot.config?.database != null &&
              !snapshot.config.database.shared_use_recommended &&
              snapshot.config.database.engine !== "unknown"
            }
          />
          <QuickFact
            label="Task runtime"
            value={
              snapshot.status
                ? snapshot.status.available
                  ? "Available"
                  : "Unavailable"
                : undefined
            }
            warning={snapshot.status != null && !snapshot.status.available}
          />
        </div>
      </section>

      <Tabs defaultValue="configuration">
        <TabsList>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
        </TabsList>

        <TabsContent value="configuration" className="mt-4">
          <SystemConfigTable
            config={snapshot.config}
            taskRuntime={snapshot.status}
          />
        </TabsContent>

        <TabsContent value="data" className="mt-4">
          <SystemDataPanel />
        </TabsContent>

        <TabsContent value="maintenance" className="mt-4">
          <SystemMaintenancePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface HealthCheck {
  key: string;
  name: string;
  ok: boolean;
  detail: string | null;
}

/** Readiness checks plus the task runtime probe, unified into one list. */
function collectChecks(snapshot: SystemSnapshot): HealthCheck[] {
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

function QuickFact({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: string | undefined;
  warning?: boolean;
}) {
  return (
    <div className="border-b p-4 last:border-b-0 sm:border-b-0 sm:border-l sm:first:border-l-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-[13px] ${warning ? "text-warning" : ""}`}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}
