import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TaskFolderSelect } from "@/components/task-folder-select";
import { type AgentTaskSummary } from "@/lib/agent-task-api";

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

const multiFolderTasks = [
  task(),
  task({ id: "support/cancel", display_name: "cancel" }),
  task({ id: "billing/invoice", folder_path: "billing", display_name: "invoice" }),
];

const allIds = ["support/refund", "support/cancel", "billing/invoice"];

describe("TaskFolderSelect — select all", () => {
  it("header checkbox selects tasks across every folder at once", async () => {
    const user = userEvent.setup();
    const onSelectedChange = vi.fn();
    render(
      <TaskFolderSelect
        tasks={multiFolderTasks}
        selected={new Set()}
        onSelectedChange={onSelectedChange}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select all tasks" }));

    expect(onSelectedChange).toHaveBeenCalledWith(new Set(allIds));
  });

  it("header checkbox clears the selection when everything is selected", async () => {
    const user = userEvent.setup();
    const onSelectedChange = vi.fn();
    render(
      <TaskFolderSelect
        tasks={multiFolderTasks}
        selected={new Set(allIds)}
        onSelectedChange={onSelectedChange}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select all tasks" }));

    expect(onSelectedChange).toHaveBeenCalledWith(new Set());
  });

  it("header checkbox only selects tasks visible under the current filter", async () => {
    const user = userEvent.setup();
    const onSelectedChange = vi.fn();
    render(
      <TaskFolderSelect
        tasks={multiFolderTasks}
        selected={new Set()}
        onSelectedChange={onSelectedChange}
      />,
    );

    await user.type(screen.getByPlaceholderText("Filter tasks..."), "invoice");
    await user.click(screen.getByRole("checkbox", { name: "Select all tasks" }));

    expect(onSelectedChange).toHaveBeenCalledWith(new Set(["billing/invoice"]));
  });
});
