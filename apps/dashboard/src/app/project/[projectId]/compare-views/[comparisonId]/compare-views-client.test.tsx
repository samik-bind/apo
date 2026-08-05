import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { CompareViewsClient } from "@/app/project/[projectId]/compare-views/[comparisonId]/compare-views-client";
import type { AgentTaskSummary } from "@/lib/agent-task-api";
import type { TaskViewComparisonSnapshot } from "@/lib/agent-task-view-api";

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme-evals",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

function task(id: string, name: string, folder: string): AgentTaskSummary {
  return {
    id, task_path: `tasks/${id}`, folder_path: folder, display_name: name,
    adapter_name: "claude-code", has_checks: false, tags: [], run_stats: null,
  };
}

const snapshot: TaskViewComparisonSnapshot = {
  id: "tvc_test",
  project_id: "acme-evals",
  view_a_config: { model: "claude-opus-4.1", effort: null },
  view_b_config: { model: "deepseek-v3", effort: null },
  task_ids: ["evals/alpha", "evals/beta"],
  // alpha: comparable; beta: def/exec disagree -> n/c (excluded from aggregate)
  resolved: [
    { task_id: "evals/alpha", a_run_id: "ra", b_run_id: "rb", a_status: "passed", b_status: "failed", comparable: true },
    { task_id: "evals/beta", a_run_id: "rc", b_run_id: "rd", a_status: "passed", b_status: "passed", comparable: false },
  ],
  coverage: { both_run: 2, comparable: 1, scope: 2 },
  created_at: "2026-08-07T00:00:00Z",
  created_by: null,
};

describe("CompareViewsClient (SPEC-174 Phase 2)", () => {
  it("renders each task A vs B with a verdict, and flags non-comparable as n/c", () => {
    render(
      <CompareViewsClient
        projectId="acme-evals"
        snapshot={snapshot}
        tasks={[task("evals/alpha", "Alpha", "evals"), task("evals/beta", "Beta", "evals")]}
      />,
    );

    // Both scoped tasks appear with their display names.
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();

    // alpha: A passed, B failed -> regressed verdict; comparable.
    expect(screen.getAllByText("Passed").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("regressed")).toBeInTheDocument();

    // beta: comparable=false -> n/c badge (excluded from aggregate).
    expect(screen.getByText("n/c")).toBeInTheDocument();

    // Coverage pill reflects the frozen aggregate.
    expect(screen.getByText("1")).toBeInTheDocument(); // comparable count
  });

  it("falls back to the raw task id for tasks no longer in inventory", () => {
    render(
      <CompareViewsClient
        projectId="acme-evals"
        snapshot={{ ...snapshot, task_ids: ["evals/gone"], resolved: [
          { task_id: "evals/gone", a_run_id: "r", b_run_id: null, a_status: "passed", b_status: null, comparable: false },
        ] }}
        tasks={[]} // inventory no longer lists it
      />,
    );
    // A task no longer in inventory renders its raw id as both the name and
    // the subtitle (the only identity the snapshot still has).
    expect(screen.getAllByText("evals/gone").length).toBeGreaterThanOrEqual(1);
    // Side B has no run -> Not Run.
    expect(screen.getAllByText("Not Run").length).toBeGreaterThan(0);
  });
});
