import { describe, expect, it } from "vitest";

import {
  acceptsCorrections,
  isJudgeNoVerdictRun,
  isVerdictSuppressedByGenerations,
  runStatusLabel,
} from "@/lib/run-verdict";

// Issue #323: the run page reads a judge no-verdict run as "No verdict" and
// keeps it correctable; other error runs stay execution errors.
const noVerdict = {
  status: "error",
  pass_result: null,
  failed_checks: 0,
  errored_checks: 1,
  error_message:
    "No verdict: 1 of 2 checks got no verdict from the judge (judge error or no judge configured); the other 1 passed.",
};
const dominated = { total: 4, errored: 3, error_finish_reasons: {} };
const minority = { total: 4, errored: 1, error_finish_reasons: {} };

describe("isJudgeNoVerdictRun", () => {
  it("recognizes a run whose only non-passing checks are judge errors", () => {
    expect(isJudgeNoVerdictRun(noVerdict)).toBe(true);
  });

  it("rejects an executor error with the same counts", () => {
    expect(isJudgeNoVerdictRun({ ...noVerdict, error_message: "adapter crashed" })).toBe(false);
  });

  it("rejects an executor error with no errored checks", () => {
    expect(isJudgeNoVerdictRun({ ...noVerdict, errored_checks: 0 })).toBe(false);
  });

  it("rejects a run with a genuine fail", () => {
    expect(isJudgeNoVerdictRun({ ...noVerdict, failed_checks: 1 })).toBe(false);
  });

  it("rejects a run that carries a verdict", () => {
    expect(isJudgeNoVerdictRun({ ...noVerdict, pass_result: false })).toBe(false);
    expect(isJudgeNoVerdictRun({ ...noVerdict, status: "failed", pass_result: false })).toBe(false);
  });

  it("rejects a generation-dominated run (#149), not a recovered minority", () => {
    expect(isJudgeNoVerdictRun({ ...noVerdict, generation_execution: dominated })).toBe(false);
    expect(isJudgeNoVerdictRun({ ...noVerdict, generation_execution: minority })).toBe(true);
  });
});

describe("run page verdict helpers", () => {
  it("labels a judge no-verdict run 'No verdict', everything else by status", () => {
    expect(runStatusLabel(noVerdict, "Error")).toBe("No verdict");
    expect(runStatusLabel({ ...noVerdict, error_message: "adapter crashed" }, "Error")).toBe("Error");
  });

  it("suppresses the verdict for #149 only when errored generations dominate", () => {
    expect(isVerdictSuppressedByGenerations({ ...noVerdict, generation_execution: dominated })).toBe(true);
    expect(isVerdictSuppressedByGenerations({ ...noVerdict, generation_execution: minority })).toBe(false);
  });

  it("accepts corrections on verdict-bearing and judge no-verdict runs only", () => {
    expect(acceptsCorrections({ status: "failed", pass_result: false })).toBe(true);
    expect(acceptsCorrections(noVerdict)).toBe(true);
    expect(acceptsCorrections({ ...noVerdict, error_message: "adapter crashed" })).toBe(false);
    expect(acceptsCorrections({ status: "running", pass_result: null })).toBe(false);
  });
});
