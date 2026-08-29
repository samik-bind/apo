"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Hourglass, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  listProjects,
  updateProjectEvidenceRetention,
  type Project,
} from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Mode = "inherit" | "forever" | "days";

/**
 * Per-project evidence-retention setting. Three states: inherit the
 * deployment default (APO_EVIDENCE_RETENTION_DAYS), keep this project's
 * evidence forever, or expire evidence after N days. Verdicts are never
 * deleted automatically — only the evidence tier (traces, checks,
 * deliverables, transcripts) is affected, and bookmarked runs always keep
 * everything. Requires project admin; the demo workspace is read-only.
 */
export function EvidenceRetentionSection() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("inherit");
  const [days, setDays] = useState("90");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    listProjects(controller.signal)
      .then((loaded) => {
        setProjects(loaded);
        if (loaded.length > 0 && loaded[0] !== undefined) {
          setSelectedId((prev) => prev ?? loaded[0]!.id);
        }
      })
      .catch(() => setProjects([]));
    return () => controller.abort();
  }, []);

  const selected = useMemo(
    () => projects?.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    if (selected.evidence_retention_days === null) setMode("inherit");
    else if (selected.evidence_retention_days === 0) setMode("forever");
    else {
      setMode("days");
      setDays(String(selected.evidence_retention_days));
    }
  }, [selected]);

  const canEdit =
    selected !== null &&
    selected.id !== "demo" &&
    (selected.current_user_role === "owner" ||
      selected.current_user_role === "admin");

  const describeEffective = useCallback((project: Project): string => {
    const eff = project.effective_evidence_retention_days ?? 0;
    if (eff === 0) return "evidence never expires";
    return `evidence expires after ${eff} day${eff === 1 ? "" : "s"}`;
  }, []);

  async function handleSave() {
    if (!selected || !canEdit) return;
    const parsedDays = Number.parseInt(days, 10);
    if (mode === "days" && (!Number.isFinite(parsedDays) || parsedDays < 1 || parsedDays > 3650)) {
      toast.error("Days must be between 1 and 3650");
      return;
    }
    const value = mode === "inherit" ? null : mode === "forever" ? 0 : parsedDays;
    setSaving(true);
    try {
      const updated = await updateProjectEvidenceRetention(selected.id, value);
      setProjects((prev) =>
        prev?.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)) ?? prev,
      );
      toast.success(
        mode === "inherit"
          ? "Retention set to inherit the deployment default"
          : mode === "forever"
            ? "Evidence will be kept forever"
            : `Evidence will expire after ${parsedDays} days`,
      );
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update retention");
    } finally {
      setSaving(false);
    }
  }

  if (projects === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
      </div>
    );
  }
  if (projects.length === 0) {
    return <p className="text-sm text-muted-foreground">No projects yet.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <label htmlFor="retention-project" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Project
        </label>
        <select
          id="retention-project"
          value={selectedId ?? undefined}
          onChange={(e) => setSelectedId(e.target.value)}
          className="mt-1.5 block w-full max-w-sm border border-border bg-card px-2.5 py-2 text-sm text-foreground"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {selected && (
          <p className="mt-2 text-xs text-muted-foreground">
            Currently {describeEffective(selected)}.
          </p>
        )}
      </div>

      <fieldset className="flex flex-col gap-2" disabled={!canEdit || saving}>
        <legend className="sr-only">Evidence retention</legend>
        <ModeOption
          label="Inherit deployment default"
          description="Use APO_EVIDENCE_RETENTION_DAYS for this project."
          active={mode === "inherit"}
          onSelect={() => setMode("inherit")}
        />
        <ModeOption
          label="Keep evidence forever"
          description="Never expire this project's evidence, even under a shorter deployment default."
          active={mode === "forever"}
          onSelect={() => setMode("forever")}
        />
        <ModeOption
          label="Expire evidence after N days"
          description="Verdicts stay forever; traces, checks, deliverables, and transcripts go after the window."
          active={mode === "days"}
          onSelect={() => setMode("days")}
        >
          <input
            type="number"
            min={1}
            max={3650}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            aria-label="Days"
            disabled={mode !== "days"}
            className="h-8 w-24 border border-border bg-card px-2 text-sm tabular-nums"
          />
        </ModeOption>
      </fieldset>

      {selected?.id === "demo" && (
        <p className="text-xs text-muted-foreground">Demo workspace is read-only.</p>
      )}
      {selected && selected.id !== "demo" && !canEdit && (
        <p className="text-xs text-muted-foreground">
          Changing retention requires project admin.
        </p>
      )}

      <div>
        <Button
          type="button"
          onClick={handleSave}
          disabled={!canEdit || saving}
          className="gap-1.5"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hourglass className="h-3.5 w-3.5" />}
          {saving ? "Saving…" : "Save retention setting"}
        </Button>
        <p className="mt-3 max-w-xl text-xs text-muted-foreground">
          Applies on the next daily maintenance pass. Bookmark a trace to keep
          that run&apos;s evidence forever regardless of this setting, and use{" "}
          <code className="font-mono">apo runs export</code> before a window
          takes evidence you still want.
        </p>
      </div>
    </div>
  );
}

function ModeOption({
  label,
  description,
  active,
  onSelect,
  children,
}: {
  label: string;
  description: string;
  active: boolean;
  onSelect: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-3 border px-3 py-2.5 transition-colors",
        active ? "border-foreground/40 bg-muted/40" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border transition-colors"
        title={label}
      >
        {active && <span className="h-2 w-2 rounded-full bg-foreground" />}
      </button>
      <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </button>
      {children}
    </div>
  );
}
