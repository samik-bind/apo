"use client";

// PROTOTYPE — variant C of the System settings IA (see ../NOTES.md).
// Hypothesis: nothing on this page is editable, so present it honestly as a
// rendered "effective configuration" document (kubectl-describe style) —
// health summary banner on top, mono document body, danger ops in a
// collapsed drawer at the bottom.

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  collectChecks,
  runStubbedAction,
  useDbStats,
  useProjects,
  useSystemSnapshot,
  type SystemSnapshot,
} from "../shared";

export function SystemVariantC({ initial }: { initial: SystemSnapshot }) {
  const { snapshot, refreshing, refresh } = useSystemSnapshot(initial);
  const { stats, loading, load } = useDbStats();
  const checks = collectChecks(snapshot);
  const failing = checks.filter((check) => !check.ok);

  const doc = useMemo(
    () => buildDocument(snapshot, stats),
    [snapshot, stats],
  );

  const copyDocument = async () => {
    try {
      await navigator.clipboard.writeText(documentToText(doc));
      toast("Configuration copied");
    } catch {
      toast.error("Copy failed — clipboard unavailable");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">System</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Effective configuration of this apo instance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={refreshing}
          >
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copyDocument}
          >
            <ClipboardCopy className="mr-1.5 size-3.5" />
            Copy
          </Button>
        </div>
      </div>

      <HealthBanner checks={checks} failing={failing} />

      <section className="border bg-card font-mono text-[13px]">
        <div className="border-b px-4 py-3 text-xs text-muted-foreground">
          <div># apo instance — effective configuration</div>
          <div># values are env-derived at startup · read-only from the dashboard</div>
        </div>
        {doc.map((section) => (
          <div key={section.name} className="border-b px-4 py-3 last:border-b-0">
            <div className="text-[13px] font-semibold text-foreground">
              {section.name}:
            </div>
            <div className="mt-1.5 flex flex-col gap-1">
              {section.rows.map((row) => (
                <div
                  key={row.key}
                  className="flex flex-wrap items-baseline gap-x-3"
                >
                  <span className="min-w-48 shrink-0 text-muted-foreground">
                    {row.key}:
                  </span>
                  <span className={row.warning ? "text-warning" : "text-foreground"}>
                    {row.value}
                  </span>
                  {row.comment ? (
                    <span className="text-[11px] text-muted-foreground/50">
                      # {row.comment}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="border-t px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={load}
            disabled={loading}
          >
            {loading
              ? "Loading…"
              : stats
                ? "Reload Table Counts"
                : "Append Table Counts"}
          </Button>
        </div>
      </section>

      <DangerDrawer />
    </div>
  );
}

function HealthBanner({
  checks,
  failing,
}: {
  checks: ReturnType<typeof collectChecks>;
  failing: ReturnType<typeof collectChecks>;
}) {
  const [open, setOpen] = useState(false);
  if (checks.length === 0) {
    return (
      <div className="border bg-card px-4 py-3 text-[13px] text-muted-foreground">
        No check data yet — hit Refresh.
      </div>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border bg-card">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-[13px]">
          {failing.length === 0 ? (
            <CheckCircle2 className="size-4 shrink-0 text-success" />
          ) : (
            <XCircle className="size-4 shrink-0 text-destructive" />
          )}
          <span className={failing.length === 0 ? "" : "font-medium text-destructive"}>
            {failing.length === 0
              ? `All ${checks.length} checks passing`
              : `${failing.length} of ${checks.length} checks failing`}
          </span>
          {open ? (
            <ChevronDown className="ml-auto size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="ml-auto size-4 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="border-t">
            {checks.map((check) => (
              <li
                key={check.key}
                className="flex items-start gap-2 border-b px-4 py-2 text-[13px] last:border-b-0"
              >
                {check.ok ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                )}
                <div className="min-w-0">
                  <div className={check.ok ? "" : "font-medium text-destructive"}>
                    {check.name}
                  </div>
                  {check.detail ? (
                    <div className="mt-0.5 break-words font-mono text-xs text-muted-foreground">
                      {check.detail}
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function DangerDrawer() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border border-destructive/50 bg-card">
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-destructive">
            Danger Zone
          </span>
          <span className="text-xs text-muted-foreground">
            3 destructive operations
          </span>
          {open ? (
            <ChevronDown className="ml-auto size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="ml-auto size-4 text-muted-foreground" />
          )}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-destructive/50">
            <DrawerRow
              title="Reset Project Data"
              description="Deletes all traces, calls, batch runs, task runs, schedules, and sessions for one project. The project and its API keys are kept."
            >
              <ProjectResetControl />
            </DrawerRow>
            <DrawerRow
              title="Reset Database"
              description="Deletes every row across all tables. The schema is kept."
            >
              <SimpleConfirm
                label="Reset Database"
                onConfirm={() => runStubbedAction("Reset Database")}
              />
            </DrawerRow>
            <DrawerRow
              title="Nuke Database"
              description="Deletes and recreates the database file itself. Nothing survives — projects, users, and keys included."
            >
              <TypedConfirm
                phrase="YES_I_AM_SURE"
                label="Nuke Database"
                onConfirm={() => runStubbedAction("Nuke Database")}
              />
            </DrawerRow>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function DrawerRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-destructive/30 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SimpleConfirm({
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
        Confirm
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
    <div className="flex items-center gap-2">
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => runStubbedAction(`Reset ${chosen?.name ?? "project"}`)}
      >
        Reset Project
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document model — one source of truth for both the rendered document and
// the clipboard copy.
// ---------------------------------------------------------------------------

interface DocRow {
  key: string;
  value: string;
  comment?: string;
  warning?: boolean;
}

interface DocSection {
  name: string;
  rows: DocRow[];
}

function buildDocument(
  snapshot: SystemSnapshot,
  stats: Record<string, number> | null,
): DocSection[] {
  const config = snapshot.config;
  const sections: DocSection[] = [
    {
      name: "topology",
      rows: [
        { key: "supported", value: config?.supported_topology ?? "—" },
        {
          key: "profile",
          value: config?.deployment_profile ?? "—",
          comment: "APO_DEPLOYMENT_PROFILE",
          warning: config?.deployment_profile === "development",
        },
        { key: "execution_mode", value: config?.task_execution_mode ?? "—" },
      ],
    },
    {
      name: "network",
      rows: [
        {
          key: "public_url",
          value: config?.public_url ?? "—",
          comment: "APO_PUBLIC_URL",
        },
        {
          key: "backend_url",
          value: config?.backend_url ?? "—",
          comment: "APO_BACKEND_URL · BACKEND_URL",
        },
        {
          key: "frontend_url",
          value: config?.frontend_url ?? "—",
          comment: "FRONTEND_URL",
        },
      ],
    },
    {
      name: "database",
      rows: [
        {
          key: "engine",
          value: config?.database.engine ?? "—",
          comment: "DATABASE_URL",
          warning:
            config?.database != null &&
            !config.database.shared_use_recommended &&
            config.database.engine !== "unknown",
        },
        { key: "host", value: config?.database.host ?? "—" },
        { key: "name", value: config?.database.name ?? "—" },
        {
          key: "credentials",
          value: config ? (config.database.credentials_configured ? "set" : "not set") : "—",
        },
      ],
    },
    {
      name: "tasks",
      rows: [
        {
          key: "scheduler",
          value:
            config?.scheduler_enabled === undefined
              ? "—"
              : config.scheduler_enabled
                ? "enabled (single owner)"
                : "disabled (no dispatch)",
          comment: "SCHEDULER_ENABLED",
          warning: config?.scheduler_enabled === false,
        },
        {
          key: "max_concurrent_batches",
          value:
            config?.max_concurrent_batches !== undefined
              ? String(config.max_concurrent_batches)
              : "—",
          comment: "AGENT_TASK_MAX_CONCURRENT_BATCHES",
        },
        {
          key: "source_cache_dir",
          value: config?.task_source_cache_dir ?? "—",
          comment: "TASK_SOURCE_CACHE_DIR",
        },
      ],
    },
    {
      name: "health",
      rows: collectChecks(snapshot).map((check) => ({
        key: check.name,
        value: check.ok ? "ok" : "FAIL",
        comment: check.detail ?? undefined,
        warning: !check.ok,
      })),
    },
  ];

  if (stats) {
    sections.push({
      name: "data",
      rows: Object.entries(stats)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([table, count]) => ({ key: table, value: String(count) })),
    });
  }

  return sections;
}

function documentToText(sections: DocSection[]): string {
  const lines = [
    "# apo instance — effective configuration",
    "# values are env-derived at startup · read-only from the dashboard",
  ];
  for (const section of sections) {
    lines.push("", `${section.name}:`);
    for (const row of section.rows) {
      const comment = row.comment ? `  # ${row.comment}` : "";
      lines.push(`  ${row.key}: ${row.value}${comment}`);
    }
  }
  return lines.join("\n");
}
