import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the heavy FlowSection (it pulls in CompareTaskRow + trace links) so the
// test stays isolated to the view-comparison header + summary.
vi.mock("../../runs/compare/components/FlowSection", () => ({
  FlowSection: ({ folder, tasks }: { folder: string; tasks: { taskId: string }[] }) => (
    <div data-testid={`flow-${folder}`}>
      {tasks.map((t) => <span key={t.taskId}>{t.taskId}</span>)}
    </div>
  ),
}));

vi.mock("@/hooks/use-url-state", () => ({
  useUrlParamSet: () => [new Set(), vi.fn()],
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme-evals",
  useIsDemo: () => false,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { CompareViewsClient } from "@/app/project/[projectId]/compare-views/[comparisonId]/compare-views-client";
import type { AgentTaskRunSummary, AgentTaskSummary } from "@/lib/agent-task-api";
import type { TaskViewComparisonSnapshot } from "@/lib/agent-task-view-api";

function task(id: string, name: string, folder: string): AgentTaskSummary {
  return {
    id, task_path: `tasks/${id}`, folder_path: folder, display_name: name,
    adapter_name: "claude-code", has_checks: false, tags: [], run_stats: null,
  };
}

function run(id: string, taskId: string, status: string, passResult: boolean, checks = 5, passed = 3): AgentTaskRunSummary {
  return {
    id, batch_run_id: "b1", task_id: taskId, task_path: `tasks/${taskId}`,
    sequence_index: 0, adapter_name: null, status, pass_result: passResult,
    started_at: "2026-08-07T00:00:00Z", completed_at: "2026-08-07T00:00:01Z",
    trace_run_id: null, error_message: null, trace_persistence_status: "pending",
    trace_error_message: null, checks_json: "null", total_checks: checks,
    passed_checks: passed, failed_checks: checks - passed, transcript_json: "null",
    deliverables_json: "null", total_cost: 100, total_tokens: 0, configured_model: null,
    configured_effort: null, task_inventory_id: null, task_source_commit_sha: null,
    unpriced_call_count: 0,
  } as unknown as AgentTaskRunSummary;
}

const snapshot: TaskViewComparisonSnapshot = {
  id: "tvc_test", project_id: "acme-evals",
  view_a_config: { model: "claude-opus-4.1", effort: null, since: null },
  view_b_config: { model: "deepseek-v3", effort: null, since: null },
  task_ids: ["evals/alpha", "evals/beta"],
  resolved: [
    { task_id: "evals/alpha", a_run_id: "ra", b_run_id: "rb", a_status: "passed", b_status: "failed", comparable: true },
    { task_id: "evals/beta", a_run_id: "rc", b_run_id: "rd", a_status: "passed", b_status: "passed", comparable: false },
  ],
  coverage: { both_run: 2, comparable: 1, scope: 2 },
  created_at: "2026-08-07T00:00:00Z", created_by: null,
};

describe("CompareViewsClient (SPEC-174)", () => {
  it("renders both view configs in the header and the differs summary", () => {
    render(
      <CompareViewsClient
        projectId="acme-evals"
        snapshot={snapshot}
        tasks={[task("evals/alpha", "Alpha", "evals"), task("evals/beta", "Beta", "evals")]}
        // alpha differs; beta has equal verdict/check counts but must remain
        // visible because its output, reasoning, trace, time, or cost may differ.
        leftRuns={[run("ra", "evals/alpha", "passed", true), run("rc", "evals/beta", "passed", true)]}
        rightRuns={[run("rb", "evals/alpha", "failed", false, 5, 0), run("rd", "evals/beta", "passed", true)]}
      />,
    );
    // Header shows both view configs.
    expect(screen.getByText("claude-opus-4.1")).toBeInTheDocument();
    expect(screen.getByText("deepseek-v3")).toBeInTheDocument();
    // Summary: 1 of 2 tasks differs, while both task rows remain inspectable.
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/tasks differ/)).toBeInTheDocument();
    expect(screen.getByText("evals/alpha")).toBeInTheDocument();
    expect(screen.getByText("evals/beta")).toBeInTheDocument();
    expect(screen.queryByText(/No differing tasks/)).not.toBeInTheDocument();
  });
});
