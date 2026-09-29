import { describe, expect, it } from "vitest";
import { aggregateResult } from "../src/agent-task/run/aggregate.ts";
import type { EvaluationItemResult } from "../src/agent-task/run/types.ts";

// Issue #323: a run whose only failing checks got no answer from the judge
// has no verdict — `pass` stays false, `noVerdict` says why.
const ok: EvaluationItemResult = { id: "ok", pass: true, reasoning: "passed" };
const judgeError: EvaluationItemResult = {
  id: "blacked-out",
  pass: false,
  reasoning: "judge failed: 504",
  outcome: "error",
};

describe("aggregateResult no-verdict rule", () => {
  it("marks a run whose only failures are judge errors", () => {
    const result = aggregateResult([ok, judgeError]);
    expect(result.pass).toBe(false);
    expect(result.noVerdict).toBe(true);
  });

  it("keeps FAIL when a genuine fail sits beside a judge error", () => {
    const result = aggregateResult([judgeError, { id: "bad", pass: false, reasoning: "missing" }]);
    expect(result.pass).toBe(false);
    expect(result.noVerdict).toBeUndefined();
  });

  it("counts an unsupported check as a genuine non-pass", () => {
    const result = aggregateResult([
      judgeError,
      { id: "no-trace", pass: false, reasoning: "no timing", outcome: "unsupported" },
    ]);
    expect(result.noVerdict).toBeUndefined();
  });

  it("derives the outcome from assertions like the backend", () => {
    // Check-level outcome missing, assertions say judge error → no verdict.
    const fromAssertions: EvaluationItemResult = {
      id: "memo",
      pass: false,
      reasoning: "judge failed",
      assertions: [
        { id: "a", pass: true, reasoning: "ok" },
        { id: "judge", pass: false, reasoning: "judge failed", outcome: "error" },
      ],
    };
    expect(aggregateResult([fromAssertions]).noVerdict).toBe(true);

    // A stale check-level "error" over a genuinely failing assertion is a FAIL.
    const genuine: EvaluationItemResult = {
      ...judgeError,
      assertions: [{ id: "shape", pass: false, reasoning: "missing field" }],
    };
    expect(aggregateResult([genuine]).noVerdict).toBeUndefined();
  });

  it("leaves passing and empty runs alone", () => {
    expect(aggregateResult([ok]).noVerdict).toBeUndefined();
    expect(aggregateResult([]).noVerdict).toBeUndefined();
  });
});
