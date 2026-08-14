"use client";

import { useEffect, useReducer } from "react";
import { useBrowserTimezone } from "@/hooks/use-client-now";
import {
  CheckCircle2,
  Clock,
  Loader2,
} from "lucide-react";
import {
  createAgentTaskSchedule,
  type AgentTaskScheduleSummary,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import { useProjectId } from "@/lib/project-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScheduleBuilder, type ScheduleBuilderValue } from "@/components/schedule/ScheduleBuilder";
import { TaskFolderSelect } from "@/components/task-folder-select";

interface CreateScheduleDialogProps {
  tasks: AgentTaskSummary[];
  initialTaskIds: string[];
  onClose: () => void;
  onCreated: (schedule: AgentTaskScheduleSummary) => void;
}

// One state machine for the schedule draft: name, schedule value (plus the
// browser timezone already applied to it), selected tasks, and wizard step.
type DialogState = {
  name: string;
  schedule: ScheduleBuilderValue;
  appliedTz: string | null;
  selected: Set<string>;
  step: "schedule" | "tasks";
};

type DialogAction =
  | { type: "SET_NAME"; name: string }
  | { type: "SET_SCHEDULE"; value: ScheduleBuilderValue }
  | { type: "APPLY_TIMEZONE"; timezone: string }
  | { type: "SET_SELECTED"; selected: Set<string> }
  | { type: "SET_STEP"; step: "schedule" | "tasks" };

function createInitialScheduleValue(timezone: string | null): ScheduleBuilderValue {
  return {
    cadence_type: "daily",
    timezone: timezone ?? "UTC",
    hour: 9,
    minute: 0,
    day_of_week: null,
    day_of_month: null,
    min_interval_days: 1,
    max_interval_days: 30,
  };
}

function initDialogState({
  initialTaskIds,
  browserTz,
}: {
  initialTaskIds: string[];
  browserTz: string | null;
}): DialogState {
  return {
    name: initialTaskIds.length === 1 ? `${initialTaskIds[0]} daily` : "",
    schedule: createInitialScheduleValue(browserTz),
    appliedTz: browserTz,
    selected: new Set(initialTaskIds),
    step: "schedule",
  };
}

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "SET_NAME":
      return { ...state, name: action.name };
    case "SET_SCHEDULE":
      return { ...state, schedule: action.value };
    case "APPLY_TIMEZONE":
      // Apply the browser default exactly once per distinct value so later
      // manual timezone edits are never clobbered.
      if (state.appliedTz === action.timezone) return state;
      return {
        ...state,
        appliedTz: action.timezone,
        schedule: { ...state.schedule, timezone: action.timezone },
      };
    case "SET_SELECTED":
      return { ...state, selected: action.selected };
    case "SET_STEP":
      return { ...state, step: action.step };
  }
}

type SubmitState = { submitting: boolean; error: string | null };
type SubmitAction =
  | { type: "START" }
  | { type: "SUCCESS" }
  | { type: "ERROR"; error: string };

function submitReducer(state: SubmitState, action: SubmitAction): SubmitState {
  switch (action.type) {
    case "START": return { submitting: true, error: null };
    case "SUCCESS": return { submitting: false, error: null };
    case "ERROR": return { submitting: false, error: action.error };
  }
}

/**
 * create a source-owned Schedule. The authenticated creator becomes
 * the fixed Execution Owner — the dialog never offers a Pool, queue TTL, task
 * root, path, or owner selector. It submits exact catalog Task IDs.
 */
export default function CreateScheduleDialog({
  tasks,
  initialTaskIds,
  onClose,
  onCreated,
}: CreateScheduleDialogProps) {
  const projectId = useProjectId();
  const browserTz = useBrowserTimezone();
  const [dialog, dispatchDialog] = useReducer(
    dialogReducer,
    { initialTaskIds, browserTz },
    initDialogState,
  );
  const { name, schedule: scheduleValue, selected, step } = dialog;
  const [submitState, dispatchSubmit] = useReducer(submitReducer, {
    submitting: false,
    error: null,
  });

  // Covers the rare case where the dialog mounted before the browser
  // timezone resolved (initial render under SSR). No-op once applied.
  useEffect(() => {
    if (browserTz) {
      dispatchDialog({ type: "APPLY_TIMEZONE", timezone: browserTz });
    }
  }, [browserTz]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selected.size === 0) {
      dispatchSubmit({ type: "ERROR", error: "Select at least one task" });
      return;
    }
    if (!name.trim()) {
      dispatchSubmit({ type: "ERROR", error: "Schedule name is required" });
      return;
    }

    dispatchSubmit({ type: "START" });
    try {
      const taskIds = tasks.flatMap((t) => (selected.has(t.id) ? [t.id] : []));
      const created = await createAgentTaskSchedule({
        project: projectId,
        name: name.trim(),
        selection: { kind: "tasks", task_ids: taskIds },
        cadence_type: scheduleValue.cadence_type,
        timezone: scheduleValue.timezone,
        hour: scheduleValue.hour,
        minute: scheduleValue.minute,
        day_of_week: scheduleValue.day_of_week,
        day_of_month: scheduleValue.day_of_month,
        min_interval_days: scheduleValue.min_interval_days,
        max_interval_days: scheduleValue.max_interval_days,
        enabled: true,
      });
      onCreated(created);
    } catch (e: unknown) {
      dispatchSubmit({ type: "ERROR", error: e instanceof Error ? e.message : "Failed to create schedule" });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-0">
          <DialogTitle>New Schedule</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Runs in your connected environment — you are the fixed Execution Owner
          </p>
        </DialogHeader>

        <form onSubmit={handleCreate} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
            <div>
              <label htmlFor="schedule-name" className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">
                Schedule Name
              </label>
              <Input
                id="schedule-name"
                value={name}
                onChange={(e) => dispatchDialog({ type: "SET_NAME", name: e.target.value })}
                placeholder="e.g. nightly-regression"
                className="font-mono"
              />
            </div>

            <div className="flex gap-1 border border-border/60 bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => dispatchDialog({ type: "SET_STEP", step: "schedule" })}
                className={`flex-1 px-4 py-2 text-sm font-medium transition-all ${
                  step === "schedule" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Clock size={13} className="inline mr-1.5 -mt-0.5" />
                Schedule
              </button>
              <button
                type="button"
                onClick={() => dispatchDialog({ type: "SET_STEP", step: "tasks" })}
                className={`flex-1 px-4 py-2 text-sm font-medium transition-all ${
                  step === "tasks" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <CheckCircle2 size={13} className="inline mr-1.5 -mt-0.5" />
                Tasks
                {selected.size > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded-full bg-primary/10 text-primary font-mono">
                    {selected.size}
                  </span>
                )}
              </button>
            </div>

            {step === "schedule" && (
              <ScheduleBuilder
                value={scheduleValue}
                onChange={(value) => dispatchDialog({ type: "SET_SCHEDULE", value })}
              />
            )}

            {step === "tasks" && (
              <div>
                <div className="mb-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Select Tasks
                  </span>
                </div>
                <TaskFolderSelect
                  tasks={tasks}
                  selected={selected}
                  onSelectedChange={(nextSelected) =>
                    dispatchDialog({ type: "SET_SELECTED", selected: nextSelected })
                  }
                  className="max-h-[360px] overflow-y-auto pr-1"
                />
              </div>
            )}
          </div>

          <div className="border-t border-border/60 px-6 py-4 flex items-center justify-between gap-3">
            {submitState.error ? (
              <p className="text-xs text-destructive">{submitState.error}</p>
            ) : selected.size > 0 ? (
              <p className="text-xs text-muted-foreground">
                {selected.size} task{selected.size !== 1 ? "s" : ""} selected
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              {step === "schedule" ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => dispatchDialog({ type: "SET_STEP", step: "tasks" })}
                >
                  Next: Select Tasks
                </Button>
              ) : (
                <Button type="submit" size="sm" disabled={submitState.submitting || selected.size === 0}>
                  {submitState.submitting ? (
                    <span className="flex items-center gap-1.5">
                      <Loader2 size={13} className="animate-spin" />
                      Creating...
                    </span>
                  ) : (
                    "Create Schedule"
                  )}
                </Button>
              )}
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
