import { describe, expect, it } from "vitest";

import {
  acceptsCorrections,
  generationErrorsDominate,
  isJudgeNoVerdictRun,
  isVerdictSuppressedByGenerations,
  runStatusLabel,
  showsErrorBanner,
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

describe("structured no_verdict_reason (issue #323)", () => {
  const base = { status: "error", pass_result: null, failed_checks: 0, errored_checks: 1 };

  it("reads the reason, never the message, when the backend sends it", () => {
    expect(isJudgeNoVerdictRun({ ...base, no_verdict_reason: "judge", error_message: "reworded" })).toBe(true);
    expect(isJudgeNoVerdictRun({ ...base, no_verdict_reason: "executor", error_message: noVerdict.error_message })).toBe(false);
    expect(isJudgeNoVerdictRun({ ...base, no_verdict_reason: null, error_message: noVerdict.error_message })).toBe(false);
  });

  it("falls back to the exact 'No verdict: ' prefix only without the field", () => {
    expect(isJudgeNoVerdictRun({ ...base, error_message: "No verdict: 1 of 2 …" })).toBe(true);
    expect(isJudgeNoVerdictRun({ ...base, error_message: "No verdicts were needed" })).toBe(false);
  });

  it("suppresses by the reason: an executor error with dominated generations keeps its banner", () => {
    const crash = {
      ...base,
      no_verdict_reason: "executor" as const,
      error_message: "adapter crashed",
      generation_execution: dominated,
    };
    expect(isVerdictSuppressedByGenerations(crash)).toBe(false);
    expect(showsErrorBanner(crash)).toBe(true);
    const gens = { ...crash, no_verdict_reason: "generations" as const, error_message: "3 of 4" };
    expect(isVerdictSuppressedByGenerations(gens)).toBe(true);
    expect(showsErrorBanner(gens)).toBe(false);
  });

  it("shows the judge no-verdict banner beside a minority of errored generations", () => {
    expect(showsErrorBanner({ ...noVerdict, generation_execution: minority })).toBe(true);
    expect(showsErrorBanner({ ...noVerdict, error_message: null })).toBe(false);
  });

  it("only an error run has its verdict suppressed by generations", () => {
    const live = { status: "running", pass_result: null, generation_execution: dominated };
    expect(isVerdictSuppressedByGenerations(live)).toBe(false);
    expect(isVerdictSuppressedByGenerations({ ...live, status: "error" })).toBe(true);
  });

  it("dominance is a strict majority: half errored does not dominate", () => {
    expect(generationErrorsDominate({ total: 4, errored: 2, error_finish_reasons: {} })).toBe(false);
    expect(generationErrorsDominate({ total: 4, errored: 3, error_finish_reasons: {} })).toBe(true);
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
