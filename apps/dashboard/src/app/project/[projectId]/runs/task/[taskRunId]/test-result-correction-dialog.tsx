"use client";

/**
 * Set / change / restore a recorded Test result.
 *
 * Opens with the recorded and current effective result, a PASS/FAIL choice,
 * and a required reason (3–1000 chars). Saving posts one correction, toasts,
 * closes, and refreshes the server state so header and body agree. Restore
 * sends `clear` after an explicit confirmation — it removes the active
 * correction, returning the test to its recorded result.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { correctTestResult, type CheckResult } from "@/lib/agent-task-api";

const REASON_MIN = 3;
const REASON_MAX = 1000;

export function TestResultCorrectionDialog({
  open,
  onOpenChange,
  taskRunId,
  check,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskRunId: string;
  check: CheckResult;
}) {
  const router = useRouter();
  const recordedPass = check.correction ? check.recorded_pass === true : check.pass === true;
  const activeAction = check.correction?.action ?? null;
  const [choice, setChoice] = useState<"pass" | "fail">(
    recordedPass ? "fail" : "pass",
  );
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const trimmed = reason.trim();
  const reasonValid = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;
  const isRestore = activeAction !== null && choice === (recordedPass ? "pass" : "fail");

  const save = async () => {
    if (saving) return;
    // Restore sends clear: choosing the recorded result with an active
    // correction means "remove the override", not "append the same value".
    const action = isRestore ? "clear" : choice === "pass" ? "set_pass" : "set_fail";
    if (action !== "clear" && !reasonValid) return;
    setSaving(true);
    try {
      await correctTestResult(taskRunId, {
        test_id: String(check.id),
        action,
        ...(action !== "clear" ? { reason: trimmed } : {}),
      });
      toast.success(
        action === "clear" ? "Recorded result restored" : "Test result corrected",
      );
      onOpenChange(false);
      setReason("");
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Correction failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">
            Correct Result — {String(check.id)}
          </DialogTitle>
          <DialogDescription>
            Recorded <Verdict pass={recordedPass} />
            {check.correction && (
              <>
                {" "}· currently <Verdict pass={check.pass === true} /> (corrected)
              </>
            )}
            . The recorded evidence is never rewritten.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Effective result</Label>
            <div className="flex gap-2" role="group" aria-label="Effective result">
              <ChoiceButton
                selected={choice === "pass"}
                onClick={() => setChoice("pass")}
                pass
              />
              <ChoiceButton
                selected={choice === "fail"}
                onClick={() => setChoice("fail")}
              />
            </div>
            {isRestore && (
              <p className="text-[12px] text-warning">
                This matches the recorded result — saving removes the active
                correction and restores the recorded verdict.
              </p>
            )}
          </div>

          {!isRestore && (
            <div className="space-y-2">
              <Label htmlFor="correction-reason">
                Reason{" "}
                <span className="text-muted-foreground">
                  ({REASON_MIN}–{REASON_MAX} chars, recorded with the correction)
                </span>
              </Label>
              <Textarea
                id="correction-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Retention is present in the KPI table; the judge missed it"
                rows={3}
                aria-invalid={reason.length > 0 && !reasonValid}
              />
              {reason.length > 0 && !reasonValid && (
                <p className="text-[12px] text-destructive">
                  Reason must be {REASON_MIN}–{REASON_MAX} characters
                  (currently {trimmed.length}).
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={saving || (!isRestore && !reasonValid)}
          >
            {saving
              ? "Saving…"
              : isRestore
                ? "Restore recorded result"
                : "Save correction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Verdict({ pass }: { pass: boolean }) {
  return (
    <span className={pass ? "text-success" : "text-destructive"}>
      {pass ? "PASS" : "FAIL"}
    </span>
  );
}

function ChoiceButton({
  selected,
  onClick,
  pass = false,
}: {
  selected: boolean;
  onClick: () => void;
  pass?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "h-8 flex-1 border px-3 text-xs font-medium transition-colors",
        selected
          ? pass
            ? "border-success bg-success/15 text-success"
            : "border-destructive bg-destructive/15 text-destructive"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {pass ? "PASS" : "FAIL"}
    </button>
  );
}
