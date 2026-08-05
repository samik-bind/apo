import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AgentTasksClient } from "@/app/project/[projectId]/tasks/tasks-client";
import {
  createAgentTaskBatchRun,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import type { ProjectTaskSource } from "@/lib/projects-api";

vi.mock("@/lib/agent-task-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-api")>(
    "@/lib/agent-task-api",
  );
  return { ...actual, createAgentTaskBatchRun: vi.fn() };
});

// Evidence-view endpoints (SPEC-174): the client fetches the model/effort
// palette on mount and view-scoped stats on tab switch. Stub them so the mount
// effect doesn't hit the network and so derived-tab stats are deterministic.
vi.mock("@/lib/agent-task-view-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent-task-view-api")>(
    "@/lib/agent-task-view-api",
  );
  return {
    ...actual,
    fetchTaskViewConfigFacets: vi.fn().mockResolvedValue([]),
    fetchTaskViewStats: vi.fn().mockResolvedValue({}),
    createTaskViewComparison: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useParams: () => ({ projectId: "acme-evals" }),
}));

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme-evals",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const originalLocation = window.location;

function task(overrides: Partial<AgentTaskSummary> = {}): AgentTaskSummary {
  return {
    id: "support/refund",
    task_path: "tasks/support/refund",
    folder_path: "support",
    display_name: "refund",
    adapter_name: "claude-code",
    has_checks: false,
    tags: [],
    run_stats: null,
    ...overrides,
  };
}

const taskSource = {
  source_type: "published",
  inventory_stale: false,
} as unknown as ProjectTaskSource;

describe("AgentTasksClient — native source-owned Run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `window.location.href =` assignment is what the client uses to navigate
    // after a successful create. jsdom throws on assignment without a setter.
    Object.defineProperty(window, "location", {
      value: { href: originalLocation.href },
      writable: true,
    });
  });

  it("never disables Run for a non-ready environment status", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );
    // Select the task first (Run is only gated on selection + permissions,
    // never on environment state).
    await user.click(screen.getAllByRole("checkbox")[0]);

    const runButtons = screen.getAllByRole("button", { name: /Run/i });
    expect(runButtons.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    // No Pool selector copy surfaces.
    expect(screen.queryByText(/Choose where this run should execute/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/executor pool/i)).not.toBeInTheDocument();
  });

  it("sends only the fields the narrowed create API accepts on Run", async () => {
    const user = userEvent.setup();
    vi.mocked(createAgentTaskBatchRun).mockResolvedValueOnce({
      id: "batch-1",
    } as Awaited<ReturnType<typeof createAgentTaskBatchRun>>);
    const tasks = [task({ id: "support/refund" }), task({ id: "support/cancel", display_name: "cancel" })];
    render(
      <AgentTasksClient
        tasks={tasks}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );

    // Open the folder and select both tasks via their checkboxes.
    const checkboxes = screen.getAllByRole("checkbox");
    // First checkbox is the folder select-all; selecting it picks every task.
    await user.click(checkboxes[0]);

    const runButtons = screen.getAllByRole("button", { name: /Run/i });
    await user.click(runButtons[0]);

    await waitFor(() => {
      expect(createAgentTaskBatchRun).toHaveBeenCalledTimes(1);
    });
    const call = vi.mocked(createAgentTaskBatchRun).mock.calls[0][0];
    expect(call.task_ids).toEqual(expect.arrayContaining(["support/refund", "support/cancel"]));
    // The backend model forbids extra fields, so any key beyond these 422s the
    // whole request — `selection_type` and `execution_target` are derived
    // server-side and must not be sent.
    expect(Object.keys(call).sort()).toEqual(["project", "run_metadata", "task_ids"]);
  });
});

describe("AgentTasksClient — evidence views (SPEC-174)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the permanent Main tab and the Model filter header", async () => {
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );
    // The Main tab is always present (permanent) and shows the "everything"
    // config readout; the Model filter is part of the unified header.
    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.getByText("everything")).toBeInTheDocument();
    // The Model filter label renders as part of the unified header (CSS
    // uppercases it visually; the DOM text is the capitalized form).
    expect(screen.getByText("Model")).toBeInTheDocument();
    // The palette fetch fires once on mount (drives the Model dropdown options).
    const { fetchTaskViewConfigFacets } = await import("@/lib/agent-task-view-api");
    await waitFor(() => {
      expect(fetchTaskViewConfigFacets).toHaveBeenCalledWith("acme-evals");
    });
  });

  it("exposes Compare on the selection action bar once tasks are checked", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={[task(), task({ id: "support/cancel", display_name: "cancel" })]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
      />,
    );
    // Select-all folder checkbox picks every task, which surfaces the bar.
    await user.click(screen.getAllByRole("checkbox")[0]);
    expect(screen.getByRole("button", { name: /Compare/i })).toBeInTheDocument();
  });
});
