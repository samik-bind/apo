import { describe, expect, it } from "vitest";

import { isJudgeNoVerdictRun } from "@/lib/run-verdict";

// Issue #323: the run page reads a judge no-verdict run as "No verdict" and
// keeps it correctable; other error runs stay execution errors.
describe("isJudgeNoVerdictRun", () => {
  const noVerdict = { status: "error", pass_result: null, failed_checks: 0, errored_checks: 1 };

  it("recognizes a run whose only non-passing checks are judge errors", () => {
    expect(isJudgeNoVerdictRun(noVerdict)).toBe(true);
  });

  it("rejects an executor error with no errored checks", () => {
    expect(isJudgeNoVerdictRun({ ...noVerdict, errored_checks: 0 })).toBe(false);
  });

  it("rejects a run with a genuine fail", () => {
    expect(isJudgeNoVerdictRun({ ...noVerdict, failed_checks: 1 })).toBe(false);
  });

  it("rejects a verdict-bearing run", () => {
    expect(isJudgeNoVerdictRun({ ...noVerdict, status: "failed", pass_result: false })).toBe(false);
  });

  it("rejects a generation-dominated run (#149)", () => {
    expect(
      isJudgeNoVerdictRun({
        ...noVerdict,
        generation_execution: { total: 4, errored: 3, error_finish_reasons: {} },
      }),
    ).toBe(false);
  });
});
