"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  deleteAgentTaskBatchRun,
  deleteAgentTaskRun,
} from "@/lib/agent-task-api";
import { useIsDemo } from "@/lib/project-router";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/** What a DeleteRunButton destroys. A "batch" is one row on the Runs page
 * and everything it owns; a "task-run" is a single run inside a batch. */
export type RunDeleteTarget =
  | { kind: "batch"; batchRunId: string; taskCount: number }
  | { kind: "task-run"; taskRunId: string };

interface DeleteRunButtonProps {
  target: RunDeleteTarget;
  /** Caller's project role allows deletion (owner/admin). Pages compute
   * this once from the project's current_user_role and thread it down. */
  canDelete: boolean;
  /** Client list owners: splice/refresh local state after success. */
  onDeleted?: () => void;
  /** Detail pages: hard-navigate after success so the target page re-fetches. */
  redirectTo?: string;
  /** Icon square for table rows (default) or labelled button for headers. */
  appearance?: "icon" | "button";
}

/** Destructive delete for batch runs and task runs, with confirmation.
 *
 * Removes checks, judgments, corrections, deliverables (rows and stored
 * objects), attempts, and traces — server-side. Demo workspace and
 * non-admin callers get a disabled button instead of a 403 surprise.
 */
export function DeleteRunButton({
  target,
  canDelete,
  onDeleted,
  redirectTo,
  appearance = "icon",
}: DeleteRunButtonProps) {
  const router = useRouter();
  const isDemo = useIsDemo();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const isBatch = target.kind === "batch";
  const noun = isBatch ? "run" : "task run";
  const disabled = isDemo || !canDelete;
  const disabledTitle = isDemo
    ? "Demo workspace is read-only"
    : "Deleting runs requires project admin";

  async function handleDelete() {
    setBusy(true);
    try {
      if (target.kind === "batch") {
        await deleteAgentTaskBatchRun(target.batchRunId);
      } else {
        await deleteAgentTaskRun(target.taskRunId);
      }
      toast.success(isBatch ? "Run deleted" : "Task run deleted");
      setOpen(false);
      if (redirectTo) {
        window.location.href = redirectTo;
      } else if (onDeleted) {
        onDeleted();
      } else {
        router.refresh();
      }
    } catch (e: unknown) {
      toast.error(
        e instanceof Error ? e.message : `Failed to delete ${noun}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const description =
    target.kind === "batch"
      ? `This permanently deletes the run, its ${target.taskCount} task run${target.taskCount === 1 ? "" : "s"}, their checks, judgments, deliverables, and traces. This cannot be undone.`
      : "This permanently deletes the task run — its checks, judgments, deliverables, and trace. This cannot be undone.";

  const triggerProps = {
    type: "button" as const,
    onClick: () => setOpen(true),
    disabled: disabled || busy,
    "aria-label": `Delete this ${noun}`,
    title: disabled ? disabledTitle : `Delete this ${noun}`,
  };

  return (
    <>
      {appearance === "button" ? (
        <Button
          {...triggerProps}
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-border bg-card text-[13px] font-normal hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      ) : (
        <button
          {...triggerProps}
          className={cn(
            "grid h-6 w-6 place-items-center rounded border transition-colors",
            disabled
              ? "cursor-not-allowed border-border text-muted-foreground/30"
              : "border-border text-muted-foreground hover:border-destructive/50 hover:text-destructive",
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isBatch ? "Delete this run?" : "Delete this task run?"}
            </AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDelete}
              disabled={busy}
            >
              {busy ? "Deleting…" : `Delete ${noun}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
