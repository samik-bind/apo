import {
  type AgentTaskRuntimeStatus,
  type RuntimeConfig,
} from "@/lib/system-api";

/**
 * The effective configuration of this apo instance, grouped by concern.
 * Every value is env-derived at startup and read-only from the dashboard —
 * the source column names the env var to change, then restart.
 */
export function SystemConfigTable({
  config,
  taskRuntime,
}: {
  config: RuntimeConfig | null;
  taskRuntime: AgentTaskRuntimeStatus | null;
}) {
  const groups: ConfigGroup[] = [
    {
      label: "Topology",
      rows: [
        { label: "Supported topology", value: config?.supported_topology },
        {
          label: "Deployment profile",
          value: config?.deployment_profile,
          warning: config?.deployment_profile === "development",
        },
        { label: "Execution mode", value: config?.task_execution_mode },
      ],
    },
    {
      label: "Network",
      rows: [
        {
          label: "Public URL",
          value: config?.public_url,
          mono: true,
          source: "APO_PUBLIC_URL",
        },
        {
          label: "Backend URL",
          value: config?.backend_url,
          mono: true,
          source: "APO_BACKEND_URL · BACKEND_URL",
        },
        {
          label: "Frontend URL",
          value: config?.frontend_url,
          mono: true,
          source: "FRONTEND_URL",
        },
      ],
    },
    {
      label: "Database",
      rows: [
        {
          label: "Engine",
          value: config?.database.engine,
          source: "DATABASE_URL",
          warning:
            config?.database != null &&
            !config.database.shared_use_recommended &&
            config.database.engine !== "unknown",
        },
        {
          label: "Host",
          value: config?.database.host ?? undefined,
          mono: true,
        },
        {
          label: "Name",
          value: config?.database.name ?? undefined,
          mono: true,
        },
        {
          label: "Credentials",
          value:
            config?.database.credentials_configured === undefined
              ? undefined
              : config.database.credentials_configured
                ? "Set"
                : "Not set",
        },
      ],
    },
    {
      label: "Tasks & Scheduler",
      rows: [
        {
          label: "Scheduler",
          value:
            config?.scheduler_enabled === undefined
              ? undefined
              : config.scheduler_enabled
                ? "Enabled (single owner)"
                : "Disabled (no dispatch)",
          source: "SCHEDULER_ENABLED",
          warning: config?.scheduler_enabled === false,
        },
        {
          label: "Max concurrent batches",
          value:
            config?.max_concurrent_batches !== undefined
              ? String(config.max_concurrent_batches)
              : undefined,
          source: "AGENT_TASK_MAX_CONCURRENT_BATCHES",
        },
        {
          label: "Task-source cache",
          value: config?.task_source_cache_dir,
          mono: true,
          source: "TASK_SOURCE_CACHE_DIR",
        },
        {
          label: "Agent task runtime",
          value:
            taskRuntime === null
              ? undefined
              : taskRuntime.available
                ? (taskRuntime.node_version ?? "Available")
                : "Unavailable",
          warning: taskRuntime != null && !taskRuntime.available,
        },
      ],
    },
  ];

  return (
    <section className="border bg-card">
      {groups.map((group) => (
        <div key={group.label} className="border-b last:border-b-0">
          <div className="bg-muted/30 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </div>
          {group.rows.map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-[160px_1fr] items-start gap-3 border-t px-4 py-2.5 md:grid-cols-[200px_1fr_240px]"
            >
              <div className="text-[13px] text-muted-foreground">
                {row.label}
              </div>
              <div
                className={`break-all text-[13px] ${row.mono ? "font-mono" : ""} ${row.warning ? "text-warning" : ""}`}
                title={row.value}
              >
                {row.value ?? "—"}
              </div>
              <div className="hidden break-all font-mono text-[11px] text-muted-foreground/60 md:block">
                {row.source ?? ""}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

interface ConfigRow {
  label: string;
  value: string | undefined;
  mono?: boolean;
  source?: string;
  warning?: boolean;
}

interface ConfigGroup {
  label: string;
  rows: ConfigRow[];
}
