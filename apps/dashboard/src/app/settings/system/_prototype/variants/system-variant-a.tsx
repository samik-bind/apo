"use client";

// PROTOTYPE — variant A of the System settings IA (see ../NOTES.md).
// Hypothesis: the page is a status page first. An aggregate verdict up top,
// everything else (config / data / destructive ops) behind tabs.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  CheckCircle2,
  CircleAlert,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  collectChecks,
  runStubbedAction,
  useDbStats,
  useProjects,
  useSystemSnapshot,
  type SystemSnapshot,
} from "../shared";

export function SystemVariantA({ initial }: { initial: SystemSnapshot }) {
  const { snapshot, refreshing, refresh } = useSystemSnapshot(initial);
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
              <p className="text-[13px] text-muted-foreground">
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
              <div key={check.key} className="flex items-start gap-2 text-[13px]">
                <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <span className="font-medium">{check.name}</span>
                  {check.detail ? (
                    <span className="text-muted-foreground"> — {check.detail}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="grid grid-cols-2 sm:grid-cols-4">
          <QuickFact label="Profile" value={snapshot.config?.deployment_profile} />
          <QuickFact
            label="Scheduler"
            value={
              snapshot.config?.scheduler_enabled === undefined
                ? undefined
                : snapshot.config.scheduler_enabled
                  ? "Enabled"
                  : "Disabled"
            }
            tone={snapshot.config?.scheduler_enabled === false ? "warning" : "default"}
          />
          <QuickFact label="Database" value={snapshot.config?.database.engine} />
          <QuickFact
            label="Task runtime"
            value={
              snapshot.status
                ? snapshot.status.available
                  ? "Available"
                  : "Unavailable"
                : undefined
            }
            tone={snapshot.status && !snapshot.status.available ? "warning" : "default"}
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
          <ConfigTable snapshot={snapshot} />
        </TabsContent>

        <TabsContent value="data" className="mt-4">
          <DataPanel />
        </TabsContent>

        <TabsContent value="maintenance" className="mt-4">
          <MaintenancePanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function QuickFact({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | undefined;
  tone?: "default" | "warning";
}) {
  return (
    <div className="border-b p-4 last:border-b-0 sm:border-b-0 sm:border-l sm:first:border-l-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1 font-mono text-[13px] ${tone === "warning" ? "text-warning" : ""}`}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

interface ConfigRow {
  label: string;
  value: string | undefined;
  mono?: boolean;
  source?: string;
  warning?: boolean;
}

function ConfigTable({ snapshot }: { snapshot: SystemSnapshot }) {
  const config = snapshot.config;
  const groups: { label: string; rows: ConfigRow[] }[] = [
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
        { label: "Host", value: config?.database.host ?? undefined, mono: true },
        { label: "Name", value: config?.database.name ?? undefined, mono: true },
        {
          label: "Credentials",
          value: config?.database.credentials_configured
            ? "Set"
            : config
              ? "Not set"
              : undefined,
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
      ],
    },
  ];

  return (
    <section className="border bg-card">
      <p className="border-b p-4 text-[13px] text-muted-foreground">
        Every value is derived from the environment at startup — nothing here is
        editable from the dashboard. Change the env var and restart.
      </p>
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
              <div className="text-[13px] text-muted-foreground">{row.label}</div>
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

function DataPanel() {
  const { stats, loading, load } = useDbStats();

  return (
    <section className="border bg-card p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Database Contents</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Row counts per table. Retention policy lives under Project →
            Retention.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Loading…" : "Load Table Counts"}
        </Button>
      </div>
      {stats ? (
        <div className="grid grid-cols-2 gap-px border bg-border sm:grid-cols-4">
          {Object.entries(stats)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([table, count]) => (
              <div key={table} className="bg-card p-3">
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {table}
                </div>
                <div className="mt-1 font-mono text-lg tabular-nums">{count}</div>
              </div>
            ))}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Counts not loaded yet.
        </p>
      )}
    </section>
  );
}

function MaintenancePanel() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">
        Destructive operations, ordered from narrowest to widest blast radius.
        Each requires an explicit second-step confirmation.
      </p>
      <DangerRow
        title="Reset Project Data"
        description="Deletes all traces, calls, batch runs, task runs, schedules, and sessions for one project. The project and its API keys are kept."
      >
        <ProjectResetControl />
      </DangerRow>
      <DangerRow
        title="Reset Database"
        description="Deletes every row across all tables, for every project. The schema is kept."
        destructive
      >
        <TwoStepConfirm
          label="Reset Database"
          onConfirm={() => runStubbedAction("Reset Database")}
        />
      </DangerRow>
      <DangerRow
        title="Nuke Database"
        description="Deletes and recreates the database file itself. Nothing survives — projects, users, and keys included."
        destructive
      >
        <TypedConfirm
          phrase="YES_I_AM_SURE"
          label="Nuke Database"
          onConfirm={() => runStubbedAction("Nuke Database")}
        />
      </DangerRow>
    </div>
  );
}

function DangerRow({
  title,
  description,
  destructive = false,
  children,
}: {
  title: string;
  description: string;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`border bg-card p-4 ${destructive ? "border-destructive/50" : ""}`}
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xl">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    </section>
  );
}

function TwoStepConfirm({
  label,
  onConfirm,
  children,
}: {
  label: string;
  onConfirm: () => void;
  children?: React.ReactNode;
}) {
  const [arming, setArming] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {children}
      {arming ? (
        <>
          <Button type="button" variant="destructive" size="sm" onClick={onConfirm}>
            {label}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setArming(false)}
          >
            Cancel
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setArming(true)}
        >
          {label}
        </Button>
      )}
    </div>
  );
}

function TypedConfirm({
  phrase,
  label,
  onConfirm,
}: {
  phrase: string;
  label: string;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  return (
    <div className="flex items-center gap-2">
      <Input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        placeholder={`Type ${phrase}`}
        aria-label={`Type ${phrase} to enable ${label}`}
        className="w-56"
      />
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={typed !== phrase}
        onClick={onConfirm}
      >
        {label}
      </Button>
    </div>
  );
}

function ProjectResetControl() {
  const projects = useProjects();
  const [selected, setSelected] = useState("");
  const chosen =
    projects.find((project) => project.id === selected) ?? projects[0];

  if (projects.length === 0) {
    return (
      <Badge variant="secondary">No Projects</Badge>
    );
  }
  return (
    <TwoStepConfirm
      label={chosen ? `Reset ${chosen.name}` : "Reset Project"}
      key={chosen?.id ?? "none"}
      onConfirm={() => runStubbedAction(`Reset ${chosen?.name ?? "project"}`)}
    >
      <select
        value={chosen?.id ?? ""}
        onChange={(event) => setSelected(event.target.value)}
        aria-label="Project to reset"
        className="h-8 border border-input bg-input/30 px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </TwoStepConfirm>
  );
}
