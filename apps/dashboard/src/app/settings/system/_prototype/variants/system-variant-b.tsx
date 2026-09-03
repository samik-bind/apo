"use client";

// PROTOTYPE — variant B of the System settings IA (see ../NOTES.md).
// Hypothesis: the page is an instance inspector. Health on the left,
// effective configuration on the right, everything scannable without
// scrolling, destructive ops quarantined in a full-width danger zone.

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, RefreshCw, XCircle } from "lucide-react";
import {
  collectChecks,
  runStubbedAction,
  useDbStats,
  useProjects,
  useSystemSnapshot,
  type SystemSnapshot,
} from "../shared";

export function SystemVariantB({ initial }: { initial: SystemSnapshot }) {
  const { snapshot, refreshing, refresh } = useSystemSnapshot(initial);
  const checks = collectChecks(snapshot);
  const failing = checks.filter((check) => !check.ok);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">System</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {checks.length === 0
              ? "No check data yet."
              : failing.length === 0
                ? `All ${checks.length} checks passing.`
                : `${failing.length} of ${checks.length} checks failing.`}
          </p>
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

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="border bg-card">
          <h2 className="border-b px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Health
          </h2>
          {checks.length === 0 ? (
            <p className="p-4 text-[13px] text-muted-foreground">
              No check data — hit Refresh.
            </p>
          ) : (
            <ul>
              {checks.map((check) => (
                <li
                  key={check.key}
                  className="flex items-start gap-2 border-b px-4 py-2.5 last:border-b-0"
                >
                  {check.ok ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <div className="min-w-0 text-[13px]">
                    <div className={check.ok ? "" : "font-medium text-destructive"}>
                      {check.name}
                    </div>
                    {check.detail ? (
                      <div className="mt-0.5 break-words text-muted-foreground">
                        {check.detail}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <DataBlock />
        </section>

        <ConfigStack snapshot={snapshot} />
      </div>

      <DangerZone />
    </div>
  );
}

function DataBlock() {
  const { stats, loading, load } = useDbStats();

  return (
    <div className="border-t">
      <div className="flex items-center justify-between px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Data
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Loading…" : stats ? "Reload Counts" : "Load Counts"}
        </Button>
      </div>
      {stats ? (
        <ul className="px-4 pb-3">
          {Object.entries(stats)
            .toSorted(([, a], [, b]) => b - a)
            .map(([table, count]) => (
              <li
                key={table}
                className="flex items-baseline justify-between gap-3 border-t py-1.5 text-[13px] first:border-t-0"
              >
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {table}
                </span>
                <span className="font-mono tabular-nums">{count}</span>
              </li>
            ))}
        </ul>
      ) : (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Row counts per table, on demand.
        </p>
      )}
    </div>
  );
}

function ConfigStack({ snapshot }: { snapshot: SystemSnapshot }) {
  const config = snapshot.config;

  const groups: {
    label: string;
    rows: { label: string; source?: string; value: string | undefined; warning?: boolean; mono?: boolean }[];
  }[] = [
    {
      label: "Topology",
      rows: [
        { label: "Topology", value: config?.supported_topology },
        {
          label: "Profile",
          source: "APO_DEPLOYMENT_PROFILE",
          value: config?.deployment_profile,
          warning: config?.deployment_profile === "development",
        },
        { label: "Execution mode", value: config?.task_execution_mode },
      ],
    },
    {
      label: "Network",
      rows: [
        { label: "Public", source: "APO_PUBLIC_URL", value: config?.public_url, mono: true },
        { label: "Backend", source: "APO_BACKEND_URL", value: config?.backend_url, mono: true },
        { label: "Frontend", source: "FRONTEND_URL", value: config?.frontend_url, mono: true },
      ],
    },
    {
      label: "Database",
      rows: [
        {
          label: "Engine",
          source: "DATABASE_URL",
          value: config?.database.engine,
          warning:
            config?.database != null &&
            !config.database.shared_use_recommended &&
            config.database.engine !== "unknown",
        },
        { label: "Host", value: config?.database.host ?? undefined, mono: true },
        { label: "Name", value: config?.database.name ?? undefined, mono: true },
      ],
    },
    {
      label: "Tasks",
      rows: [
        {
          label: "Scheduler",
          source: "SCHEDULER_ENABLED",
          value:
            config?.scheduler_enabled === undefined
              ? undefined
              : config.scheduler_enabled
                ? "Enabled (single owner)"
                : "Disabled (no dispatch)",
          warning: config?.scheduler_enabled === false,
        },
        {
          label: "Max batches",
          source: "AGENT_TASK_MAX_CONCURRENT_BATCHES",
          value:
            config?.max_concurrent_batches !== undefined
              ? String(config.max_concurrent_batches)
              : undefined,
        },
        {
          label: "Source cache",
          source: "TASK_SOURCE_CACHE_DIR",
          value: config?.task_source_cache_dir,
          mono: true,
        },
      ],
    },
  ];

  return (
    <section className="border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Configuration
        </h2>
        <span className="text-[11px] text-muted-foreground/60">
          env-derived · read-only
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.label} className="border-b last:border-b-0">
          <div className="bg-muted/30 px-4 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            {group.label}
          </div>
          {group.rows.map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-[130px_1fr] items-baseline gap-3 border-t px-4 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-xs text-muted-foreground">
                  {row.label}
                </div>
                {row.source ? (
                  <div className="truncate font-mono text-[10px] text-muted-foreground/50">
                    {row.source}
                  </div>
                ) : null}
              </div>
              <div
                className={`break-all text-[13px] ${row.mono ? "font-mono" : ""} ${row.warning ? "text-warning" : ""}`}
                title={row.value}
              >
                {row.value ?? "—"}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function DangerZone() {
  return (
    <section className="border border-destructive/50 bg-card">
      <div className="border-b border-destructive/50 px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-destructive">
          Danger Zone
        </h2>
      </div>
      <DangerRow
        scope="Project"
        title="Reset Project Data"
        description="Deletes all traces, calls, batch runs, task runs, schedules, and sessions for one project. The project and its API keys are kept."
      >
        <ProjectResetControl />
      </DangerRow>
      <DangerRow
        scope="All projects"
        title="Reset Database"
        description="Deletes every row across all tables. The schema is kept."
      >
        <ArmingControl
          label="Reset Database"
          onConfirm={() => runStubbedAction("Reset Database")}
        />
      </DangerRow>
      <DangerRow
        scope="Instance"
        title="Nuke Database"
        description="Deletes and recreates the database file itself. Nothing survives — projects, users, and keys included."
      >
        <TypedControl
          phrase="YES_I_AM_SURE"
          label="Nuke Database"
          onConfirm={() => runStubbedAction("Nuke Database")}
        />
      </DangerRow>
    </section>
  );
}

function DangerRow({
  scope,
  title,
  description,
  children,
}: {
  scope: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b px-4 py-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="max-w-xl">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Badge variant="outline">{scope}</Badge>
        </div>
        <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ArmingControl({
  label,
  onConfirm,
}: {
  label: string;
  onConfirm: () => void;
}) {
  const [arming, setArming] = useState(false);
  if (!arming) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setArming(true)}
      >
        {label}
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="destructive" size="sm" onClick={onConfirm}>
        Confirm {label}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setArming(false)}
      >
        Cancel
      </Button>
    </div>
  );
}

function TypedControl({
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
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        placeholder={`Type ${phrase}`}
        aria-label={`Type ${phrase} to enable ${label}`}
        className="w-52"
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
    return <Badge variant="secondary">No Projects</Badge>;
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
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
      <ArmingControl
        key={chosen?.id ?? "none"}
        label="Reset Project"
        onConfirm={() => runStubbedAction(`Reset ${chosen?.name ?? "project"}`)}
      />
    </div>
  );
}
