/**
 * Issue #323: a judgment with a null pass_result has no verdict — it renders
 * "No verdict" in warning tone, never the red FAIL tone.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import type { AgentTaskJudgmentSummary } from "@/lib/agent-task-api";
import { RunJudgmentsSection } from "./run-judgments-section";

function judgment(overrides: Partial<AgentTaskJudgmentSummary>): AgentTaskJudgmentSummary {
  return {
    id: "run-1",
    task_run_id: "run-1",
    trigger: "original",
    label: null,
    judge_model: "judge/x",
    judge_base_url: null,
    task_definition_revision_id: null,
    definition_revision_matches_run: true,
    samples: 1,
    pass_result: true,
    total_checks: 3,
    passed_checks: 3,
    failed_checks: 0,
    errored_checks: 0,
    created_at: null,
    ...overrides,
  };
}

describe("RunJudgmentsSection verdicts", () => {
  it("renders a null pass_result as No verdict in warning tone", () => {
    render(
      <RunJudgmentsSection
        taskRunId="run-1"
        judgments={[judgment({ pass_result: null, passed_checks: 2, errored_checks: 1 })]}
      />,
    );

    expect(screen.getByText("No verdict")).toBeInTheDocument();
    const score = screen.getByText("2/3");
    expect(score.className).toContain("text-warning");
    expect(score.className).not.toContain("text-destructive");
  });

  it("keeps the FAIL tone for a genuine failing judgment", () => {
    render(
      <RunJudgmentsSection
        taskRunId="run-1"
        judgments={[judgment({ pass_result: false, passed_checks: 2, failed_checks: 1 })]}
      />,
    );

    expect(screen.queryByText("No verdict")).not.toBeInTheDocument();
    expect(screen.getByText("2/3").className).toContain("text-destructive");
  });
});
