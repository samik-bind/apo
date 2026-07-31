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
    has_user_simulator: false,
    tags: [],
    run_stats: null,
    ...overrides,
  };
}

const taskSource = {
  source_type: "published",
  inventory_stale: false,
} as unknown as ProjectTaskSource;

describe("AgentTasksClient — native source-owned Run (SPEC-162)", () => {
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
        connectedState="offline"
        connectedStateError={null}
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

  it("sends exact Task IDs with a source-owned target on Run", async () => {
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
        connectedState="ready"
        connectedStateError={null}
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
    expect(call.execution_target).toEqual({ kind: "source_owned" });
    expect(call.task_root).toBeUndefined();
    expect(call.task_paths).toBeUndefined();
  });

  it("shows non-blocking copy when status fetch fails", async () => {
    const user = userEvent.setup();
    render(
      <AgentTasksClient
        tasks={[task()]}
        error={null}
        taskSource={taskSource}
        isDemo={false}
        connectedState={null}
        connectedStateError="boom"
      />,
    );
    expect(
      screen.getByText(/Connected environment status unavailable/i),
    ).toBeInTheDocument();
    // Select the task; Run stays enabled despite the status failure.
    await user.click(screen.getAllByRole("checkbox")[0]);
    const runButtons = screen.getAllByRole("button", { name: /Run/i });
    expect(runButtons.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });
});
