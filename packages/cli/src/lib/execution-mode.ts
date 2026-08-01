type TaskExecutionPreference = "local" | "backend" | "auto";

/**
 * The resolved dispatch intent for `apo task run` (SPEC-136).
 *
 * `run()` consults reachability *after* this function returns, to decide
 * whether `local-recorded` / `backend` can actually reach the backend or
 * have to degrade to `local-unrecorded`. This function is pure — it never
 * performs I/O or checks reachability — so the precedence is fully
 * deterministic from inputs alone and trivially testable.
 */
export type ExecutionMode =
  | "local-recorded" // run on dev machine, record on backend (Issue #4 path)
  | "backend" // backend spawns the subprocess (today's implicit default)
  | "local-unrecorded"; // offline fallback when no project / backend down

/**
 * Why a mode was chosen. `run()` prints the implicit-dispatch notice only
 * for task/project reasons (the agent can't see those); flag/default/
 * no-project produce today's existing output.
 */
export type ExecutionReason = "flag" | "task" | "project" | "default" | "no-project";

export type ExecutionModeResult = {
  mode: ExecutionMode;
  reason: ExecutionReason;
};

export type ExecutionModeInput = {
  /** `--local` explicit override. */
  flagLocal: boolean;
  /** `--remote` explicit override — force backend execution (symmetric to --local). */
  flagRemote: boolean;
  /** The task's `execution` declaration, if any. `auto` == no preference. */
  taskExecution: TaskExecutionPreference | undefined;
  /** The project's stored `default_execution`, if any. */
  projectDefault: "local" | "backend" | undefined;
  /** Whether a project is configured for this run. */
  hasProject: boolean;
};

/**
 * Resolve where `apo task run` should dispatch, in this exact order
 * (SPEC-136 §"CLI dispatch (final form)"):
 *
 *   1. --local flag            → local-recorded (flag)
 *   2. --remote flag           → backend        (flag)
 *   3. task.execution=local    → local-recorded (task)
 *   4. task.execution=backend  → backend        (task)
 *   5. project default=local   → local-recorded (project)
 *   6. project default=backend → backend        (project)
 *   7. project set             → backend        (default; reachability checked later)
 *   8. else                    → local-unrecorded (no-project)
 *
 * `--remote` (not `--backend`) is the symmetric override because `--backend`
 * is already the global backend-URL flag. Pure: no `await`, no
 * `isBackendReachable`. The caller applies reachability afterward to degrade
 * `local-recorded`/`backend` → `local-unrecorded` when the backend is down.
 */
export function resolveExecutionMode(input: ExecutionModeInput): ExecutionModeResult {
  // 1–2. Explicit flags win over everything. If both are passed, --local is
  // the "run here, no matter what" override and takes precedence so the
  // choice is deterministic rather than silent.
  if (input.flagLocal) return { mode: "local-recorded", reason: "flag" };
  if (input.flagRemote) return { mode: "backend", reason: "flag" };

  // 3–4. The task knows its resource needs better than the project does.
  // `auto` is treated as no preference and falls through to the project layer.
  if (input.taskExecution === "local") return { mode: "local-recorded", reason: "task" };
  if (input.taskExecution === "backend") return { mode: "backend", reason: "task" };

  // 5–6. Project default is a convenience for "most of my tasks are local".
  if (input.projectDefault === "local") return { mode: "local-recorded", reason: "project" };
  if (input.projectDefault === "backend") return { mode: "backend", reason: "project" };

  // 7. SPEC-165: the implicit default is caller (local recorded) execution.
  //    Bundled/backend execution is retired — the narrowed API rejects its fields.
  if (input.hasProject) return { mode: "local-recorded", reason: "default" };

  // 8. Offline: no project, run locally without recording (today's fallback).
  return { mode: "local-unrecorded", reason: "no-project" };
}
