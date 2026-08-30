/**
 * Status-filter vocabularies, one per entity.
 *
 * The three list pages share one filter bar, but "status" means a different
 * thing on each: a task's last outcome, a single run's outcome, and a batch
 * run's lifecycle. Keeping the vocabularies here (instead of re-defined per
 * page) is what lets the shared component stay vocabulary-agnostic — and it
 * keeps `run-cohort`'s rule clean that status deliberately does not travel
 * between pages.
 *
 * Note the task-list's "Errored" vs the run-level "Error": same concept,
 * different granularity labels — preserved because the task list also has
 * "Not Run" (no runs yet), which run-level lists can never have.
 */

export interface StatusFilterOption {
  value: string;
  label: string;
  /** Color = state: the dot is the only accent these rows get. */
  dot: string;
  /** Row count, when the page can compute one cheaply. */
  count?: number;
}

/** Tasks list: a task's last-run outcome, plus "no runs yet". */
export const TASK_STATUS_FILTERS: StatusFilterOption[] = [
  { value: "passed", label: "Passed", dot: "bg-success" },
  { value: "failed", label: "Failed", dot: "bg-destructive" },
  { value: "errored", label: "Errored", dot: "bg-warning" },
  { value: "idle", label: "Not Run", dot: "bg-muted-foreground/30" },
];

/** Task detail: run-level outcomes — "idle" is a task-list concept. */
export const TASK_RUN_STATUS_FILTERS: StatusFilterOption[] = [
  { value: "passed", label: "Passed", dot: "bg-success" },
  { value: "failed", label: "Failed", dot: "bg-destructive" },
  { value: "error", label: "Errored", dot: "bg-warning" },
];

/**
 * Runs list: batch-run lifecycle statuses. Batches are never "passed" — a
 * completed batch's pass/fail mix lives in its task runs — so this
 * vocabulary replaces the old dropdown whose "Passed" option silently
 * matched nothing.
 */
export const BATCH_RUN_STATUS_FILTERS: StatusFilterOption[] = [
  { value: "queued", label: "Queued", dot: "bg-muted-foreground/30" },
  { value: "running", label: "Running", dot: "bg-foreground/50" },
  { value: "completed", label: "Completed", dot: "bg-success" },
  { value: "partial", label: "Partial", dot: "bg-warning" },
  { value: "failed", label: "Failed", dot: "bg-destructive" },
  { value: "error", label: "Error", dot: "bg-destructive/70" },
];
