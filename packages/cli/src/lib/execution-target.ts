/**
 * canonical execution-target resolution for `apo task run`.
 *
 * Placement is resolved once from explicit flags > task compatibility >
 * project preference > default. Crucially it takes NO reachability input:
 * backend reachability never changes placement (a configured recording either
 * succeeds or fails explicitly — it never silently degrades to unrecorded).
 *
 * `--remote` and task `execution:"backend"` require a Project Bundled Pool; if
 * none is configured they throw a configuration error rather than falling back
 * to caller.
 */

export type ExecutionTarget =
  | { kind: "caller" }
  | { kind: "pool"; poolId: string };

export type TargetReason =
  | "flag"
  | "task-compatibility"
  | "project-compatibility"
  | "default";

export interface ResolveExecutionTargetInput {
  executorFlag?: string;
  localFlag: boolean;
  remoteFlag: boolean;
  taskExecution?: "local" | "backend" | "auto";
  defaultExecutor?: "caller" | string; // "caller" or a Pool ID
  legacyDefaultExecution?: "local" | "backend";
  bundledPoolId?: string;
}

export interface ResolveExecutionTargetResult {
  target: ExecutionTarget;
  reason: TargetReason;
}

export class ExecutionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionTargetError";
  }
}

/**
 * Resolve the execution target. Throws ExecutionTargetError when an explicit
 * remote/backend placement is requested but no Bundled Pool is configured.
 */
export function resolveExecutionTarget(
  input: ResolveExecutionTargetInput,
): ResolveExecutionTargetResult {
  const { executorFlag, localFlag, remoteFlag, taskExecution } = input;

  // 1. Explicit --executor wins over everything.
  if (executorFlag !== undefined) {
    if (executorFlag === "caller") {
      return { target: { kind: "caller" }, reason: "flag" };
    }
    return { target: { kind: "pool", poolId: executorFlag }, reason: "flag" };
  }

  // 2. --local compatibility alias -> caller.
  if (localFlag) {
    return { target: { kind: "caller" }, reason: "flag" };
  }

  // 3. --remote compatibility requires a Bundled Pool.
  if (remoteFlag) {
    return { target: poolOrThrow(input), reason: "flag" };
  }

  // 4. Task execution compatibility.
  if (taskExecution === "local") {
    return { target: { kind: "caller" }, reason: "task-compatibility" };
  }
  if (taskExecution === "backend") {
    return { target: poolOrThrow(input), reason: "task-compatibility" };
  }

  // 5. New default_executor preference (overrides legacy).
  if (input.defaultExecutor !== undefined) {
    if (input.defaultExecutor === "caller") {
      return { target: { kind: "caller" }, reason: "project-compatibility" };
    }
    return {
      target: { kind: "pool", poolId: input.defaultExecutor },
      reason: "project-compatibility",
    };
  }

  // 6. Legacy default_execution.
  if (input.legacyDefaultExecution === "local") {
    return { target: { kind: "caller" }, reason: "project-compatibility" };
  }
  if (input.legacyDefaultExecution === "backend") {
    return { target: poolOrThrow(input), reason: "project-compatibility" };
  }

  // 7. Default -> caller.
  return { target: { kind: "caller" }, reason: "default" };
}

function poolOrThrow(input: ResolveExecutionTargetInput): { kind: "pool"; poolId: string } {
  if (!input.bundledPoolId) {
    throw new ExecutionTargetError(
      "remote/backend execution requires a configured Project Bundled Pool",
    );
  }
  return { kind: "pool", poolId: input.bundledPoolId };
}
