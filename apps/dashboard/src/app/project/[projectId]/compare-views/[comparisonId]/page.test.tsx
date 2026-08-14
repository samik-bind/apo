import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOverview: vi.fn(),
  listTasks: vi.fn(),
  renderClient: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "user-agent": "vitest" })),
}));

vi.mock("@/lib/agent-task-api", () => ({
  listProjectAgentTasks: mocks.listTasks,
}));

vi.mock("@/lib/agent-task-view-api", () => ({
  getTaskViewComparisonOverview: mocks.getOverview,
}));

vi.mock("./compare-views-client", () => ({
  CompareViewsClient: (props: unknown) => {
    mocks.renderClient(props);
    return <div>comparison loaded</div>;
  },
}));

import CompareViewsPage from "./page";

describe("CompareViewsPage", () => {
  beforeEach(() => {
    mocks.getOverview.mockReset();
    mocks.listTasks.mockReset();
    mocks.renderClient.mockReset();
  });

  it("hydrates from the lightweight overview, not bulk evidence", async () => {
    const snapshot = {
      id: "tvc_1",
      project_id: "project-1",
      view_a_config: { model: "kimi", effort: null, since: null },
      view_b_config: { model: "opus", effort: null, since: null },
      task_ids: ["task-1"],
      resolved: [{
        task_id: "task-1",
        a_run_id: "run-a",
        b_run_id: "run-b",
        a_status: "passed",
        b_status: "passed",
        state: "aligned",
      }],
      coverage: { both_run: 1, aligned: 1, scope: 1 },
      created_at: "2026-08-12T00:00:00Z",
      created_by: null,
    };
    const runs = [
      { id: "run-a", task_id: "task-1" },
      { id: "run-b", task_id: "task-1" },
    ];
    mocks.getOverview.mockResolvedValue({ snapshot, runs });
    mocks.listTasks.mockResolvedValue([]);

    render(await CompareViewsPage({
      params: Promise.resolve({ projectId: "project-1", comparisonId: "tvc_1" }),
    }));

    expect(screen.getByText("comparison loaded")).toBeInTheDocument();
    expect(mocks.getOverview).toHaveBeenCalledOnce();
    expect(mocks.getOverview).toHaveBeenCalledWith("project-1", "tvc_1");
    expect(mocks.renderClient).toHaveBeenCalledWith(expect.objectContaining({
      snapshot,
      comparisonId: "tvc_1",
      leftRuns: [runs[0]],
      rightRuns: [runs[1]],
    }));
  });

  it("production-shaped scene: 42 tasks, 53 runs, no bulk endpoint during SSR", async () => {
    // Mirror the production incident: 42 selected tasks, 53 unique resolved
    // runs. The overview must return summaries only and the page must never
    // call the old bulk-evidence endpoint or task-evidence during SSR.
    const NUM_TASKS = 42;
    const taskIds = Array.from({ length: NUM_TASKS }, (_, i) => `task-${i}`);
    const resolved = taskIds.map((tid, i) => ({
      task_id: tid,
      a_run_id: `run-a-${i}`,
      // Share some run IDs on the B side so total unique < 2 * NUM_TASKS.
      b_run_id: i < 11 ? `run-b-${i}` : `run-b-${i - 11}`,
      a_status: i % 3 === 0 ? "passed" : i % 3 === 1 ? "failed" : "error",
      b_status: "passed",
      state: i % 2 === 0 ? "aligned" : "different_definition",
    }));

    const leftRuns = taskIds.map((tid, i) => ({
      id: `run-a-${i}`,
      task_id: tid,
      status: i % 3 === 0 ? "passed" : i % 3 === 1 ? "failed" : "error",
      total_checks: 5,
      passed_checks: 3,
      failed_checks: 2,
    }));
    // 42 A runs + 11 unique B runs = 53 unique runs.
    const rightRuns = taskIds.slice(0, 11).map((tid, i) => ({
      id: `run-b-${i}`,
      task_id: tid,
      status: "passed",
      total_checks: 5,
      passed_checks: 5,
      failed_checks: 0,
    }));

    const snapshot = {
      id: "tvc_prod",
      project_id: "project-prod",
      view_a_config: { model: "claude-sonnet", effort: "high", since: null },
      view_b_config: { model: "gpt-4o", effort: "high", since: null },
      task_ids: taskIds,
      resolved,
      coverage: { both_run: NUM_TASKS, aligned: 21, scope: NUM_TASKS },
      created_at: "2026-08-13T00:00:00Z",
      created_by: null,
    };

    mocks.getOverview.mockResolvedValue({ snapshot, runs: [...leftRuns, ...rightRuns] });
    mocks.listTasks.mockResolvedValue([]);

    render(await CompareViewsPage({
      params: Promise.resolve({ projectId: "project-prod", comparisonId: "tvc_prod" }),
    }));

    // Overview was called exactly once — no bulk-evidence or task-evidence.
    expect(mocks.getOverview).toHaveBeenCalledOnce();
    expect(mocks.getOverview).toHaveBeenCalledWith("project-prod", "tvc_prod");

    // All tasks are wired into the client.
    const clientProps = mocks.renderClient.mock.calls[0][0] as {
      snapshot: { task_ids: string[] };
      leftRuns: { id: string }[];
      rightRuns: { id: string }[];
    };
    expect(clientProps.snapshot.task_ids).toHaveLength(NUM_TASKS);
    expect(clientProps.leftRuns).toHaveLength(NUM_TASKS);
  });
});
