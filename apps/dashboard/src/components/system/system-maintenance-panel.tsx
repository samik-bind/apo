"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isUnauthorized } from "@/lib/api-error";
import { apiClient } from "@/lib/api-client";
import { listProjects, type Project } from "@/lib/projects-api";
import { nukeDatabase, resetDatabase } from "@/lib/system-api";
import { toast } from "sonner";

/**
 * Destructive operations, ordered from narrowest to widest blast radius.
 * Each requires an explicit second-step confirmation.
 */
export function SystemMaintenancePanel() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-muted-foreground">
        Use these for local recovery or development, not during normal task,
        run, or trace work.
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
        <ResetDatabaseControl />
      </DangerRow>
      <DangerRow
        title="Nuke Database"
        description="Deletes and recreates the database file itself. Nothing survives — projects, users, and keys included."
        destructive
      >
        <NukeDatabaseControl />
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
          <p className="mt-1 text-[13px] text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    </section>
  );
}

function describeFailure(error: unknown, action: string): string {
  return isUnauthorized(error)
    ? `${action} rejected — set the same ADMIN_API_KEY on the backend and the dashboard, then retry.`
    : error instanceof Error
      ? `${action} failed — ${error.message}`
      : `${action} failed.`;
}

function ProjectResetControl() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [arming, setArming] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    listProjects()
      .then((all) => {
        setProjects(all);
        if (all.length > 0) setSelected(all[0]!.id);
      })
      .catch(() => {});
  }, []);

  if (projects.length === 0) {
    return <Badge variant="secondary">No Projects</Badge>;
  }

  const reset = async () => {
    setResetting(true);
    try {
      const data = await apiClient<{ deleted: Record<string, number> }>(
        `/v1/projects/${selected}/reset-data`,
        { method: "POST" },
      );
      const summary = Object.entries(data.deleted)
        .filter(([, count]) => count > 0)
        .map(([table, count]) => `${count} ${table}`)
        .join(", ");
      toast.success(
        summary ? `Project reset — deleted ${summary}` : "Project reset",
      );
      setArming(false);
    } catch (e) {
      toast.error(describeFailure(e, "Project reset"));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={selected}
        onChange={(event) => {
          setSelected(event.target.value);
          setArming(false);
        }}
        aria-label="Project to reset"
        className="h-8 border border-input bg-input/30 px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      {arming ? (
        <>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={reset}
            disabled={resetting}
          >
            {resetting ? "Resetting…" : "Delete Project Data"}
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
          Reset Project Data
        </Button>
      )}
    </div>
  );
}

function ResetDatabaseControl() {
  const [arming, setArming] = useState(false);
  const [working, setWorking] = useState(false);

  const reset = async () => {
    setWorking(true);
    try {
      const data = await resetDatabase();
      toast.success(data.message);
      setArming(false);
    } catch (e) {
      toast.error(describeFailure(e, "Database reset"));
    } finally {
      setWorking(false);
    }
  };

  if (!arming) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setArming(true)}
      >
        Reset Database
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={reset}
        disabled={working}
      >
        {working ? "Resetting…" : "Delete All Rows"}
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

const NUKE_PHRASE = "YES_I_AM_SURE";

function NukeDatabaseControl() {
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);

  const nuke = async () => {
    setWorking(true);
    try {
      const data = await nukeDatabase();
      toast.success(data.message);
      setTyped("");
    } catch (e) {
      toast.error(describeFailure(e, "Database nuke"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        placeholder={`Type ${NUKE_PHRASE}`}
        aria-label={`Type ${NUKE_PHRASE} to enable nuking the database`}
        className="w-56"
      />
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={typed !== NUKE_PHRASE || working}
        onClick={nuke}
      >
        {working ? "Nuking…" : "Nuke Database"}
      </Button>
    </div>
  );
}
