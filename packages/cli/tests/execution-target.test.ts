import { describe, it, expect } from "vitest";
import { resolveExecutionTarget } from "../src/lib/execution-target.ts";

/**
 * resolveExecutionTarget precedence.
 * Reachability is deliberately NOT an input — placement never changes with
 * backend reachability. `--remote` / task `backend` require a Bundled Pool.
 */

describe("resolveExecutionTarget precedence", () => {
  const base = { localFlag: false, remoteFlag: false };

  it("1. explicit --executor overrides legacy flags, task hints, and preferences", () => {
    expect(resolveExecutionTarget({
      ...base, executorFlag: "caller", remoteFlag: true,
      taskExecution: "backend", defaultExecutor: "pool-9",
    })).toEqual({ target: { kind: "caller" }, reason: "flag" });
    expect(resolveExecutionTarget({
      ...base, executorFlag: "pool-7", localFlag: true, defaultExecutor: "caller",
    })).toEqual({ target: { kind: "pool", poolId: "pool-7" }, reason: "flag" });
  });

  it("2. --local alias resolves to caller (flag)", () => {
    expect(resolveExecutionTarget({ ...base, localFlag: true, defaultExecutor: "pool-1" }))
      .toEqual({ target: { kind: "caller" }, reason: "flag" });
  });

  it("3. --remote requires a Bundled Pool (flag), else a configuration error", () => {
    expect(resolveExecutionTarget({ ...base, remoteFlag: true, bundledPoolId: "bundled-1" }))
      .toEqual({ target: { kind: "pool", poolId: "bundled-1" }, reason: "flag" });
    expect(() => resolveExecutionTarget({ ...base, remoteFlag: true }))
      .toThrow(/bundled/i);
  });

  it("4. task execution compatibility: local -> caller, backend -> Bundled Pool", () => {
    expect(resolveExecutionTarget({ ...base, taskExecution: "local" }))
      .toEqual({ target: { kind: "caller" }, reason: "task-compatibility" });
    expect(resolveExecutionTarget({ ...base, taskExecution: "backend", bundledPoolId: "b1" }))
      .toEqual({ target: { kind: "pool", poolId: "b1" }, reason: "task-compatibility" });
    expect(() => resolveExecutionTarget({ ...base, taskExecution: "backend" }))
      .toThrow(/bundled/i);
    // 'auto' is not a directive -> falls through.
    expect(resolveExecutionTarget({ ...base, taskExecution: "auto" }))
      .toEqual({ target: { kind: "caller" }, reason: "default" });
  });

  it("5. new default_executor preference overrides legacy default_execution", () => {
    expect(resolveExecutionTarget({
      ...base, defaultExecutor: "pool-3", legacyDefaultExecution: "local",
    })).toEqual({ target: { kind: "pool", poolId: "pool-3" }, reason: "project-compatibility" });
    expect(resolveExecutionTarget({
      ...base, defaultExecutor: "caller", legacyDefaultExecution: "backend", bundledPoolId: "b1",
    })).toEqual({ target: { kind: "caller" }, reason: "project-compatibility" });
  });

  it("6. no preference resolves to caller (default)", () => {
    expect(resolveExecutionTarget({ ...base })).toEqual({ target: { kind: "caller" }, reason: "default" });
  });

  it("7. legacy default_execution maps: local -> caller, backend -> Bundled Pool", () => {
    expect(resolveExecutionTarget({ ...base, legacyDefaultExecution: "local" }))
      .toEqual({ target: { kind: "caller" }, reason: "project-compatibility" });
    expect(resolveExecutionTarget({ ...base, legacyDefaultExecution: "backend", bundledPoolId: "b1" }))
      .toEqual({ target: { kind: "pool", poolId: "b1" }, reason: "project-compatibility" });
    expect(() => resolveExecutionTarget({ ...base, legacyDefaultExecution: "backend" }))
      .toThrow(/bundled/i);
  });
});
