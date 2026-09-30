import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentTaskRunSummary } from "@/lib/agent-task-api";
import { useComparison } from "./use-comparison";

// Issue #323: a judge no-verdict run is its own state in the compare view —
// neither an execution error nor a FAIL.
function run(overrides: Partial<AgentTaskRunSummary>): AgentTaskRunSummary {
  return {
    id: "r",
    task_id: "t",
    task_path: "tasks/t",
    status: "error",
    pass_result: null,
    total_checks: 3,
    passed_checks: 2,
    failed_checks: 0,
    errored_checks: 1,
    ...overrides,
  } as AgentTaskRunSummary;
}

function differs(left: AgentTaskRunSummary, right: AgentTaskRunSummary): boolean {
  const { result } = renderHook(() => useComparison([left], [right], []));
  return result.current.folders.flatMap((f) => f.tasks)[0]!.differs;
}

describe("useComparison verdicts (issue #323)", () => {
  it("tells a judge no-verdict apart from an execution error with the same counts", () => {
    expect(
      differs(run({ id: "a", no_verdict_reason: "judge" }), run({ id: "b", no_verdict_reason: "executor" })),
    ).toBe(true);
  });

  it("two judge no-verdict runs with the same counts don't differ", () => {
    expect(
      differs(run({ id: "a", no_verdict_reason: "judge" }), run({ id: "b", no_verdict_reason: "judge" })),
    ).toBe(false);
  });

  it("a moved judge-errored check is a difference", () => {
    expect(
      differs(
        run({ id: "a", no_verdict_reason: "judge" }),
        run({ id: "b", no_verdict_reason: "judge", passed_checks: 1, errored_checks: 2 }),
      ),
    ).toBe(true);
  });

  it("differs on errored_checks alone", () => {
    // A snapshot frozen before errored_checks existed overlays total/passed
    // and reads every non-passing check as failed; errored stays live. Two
    // FAILs 2/3 differ when one of them has a judge-errored check.
    const failed = { status: "failed", pass_result: false, no_verdict_reason: null, failed_checks: 1 };
    expect(
      differs(run({ id: "a", ...failed, errored_checks: 1 }), run({ id: "b", ...failed, errored_checks: 0 })),
    ).toBe(true);
  });
});
