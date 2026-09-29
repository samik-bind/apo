/**
 * Issue #323: run rows render a judge no-verdict run's message in warning
 * tone under a "No verdict" label; an executor error keeps the red message.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { InlineTaskRunRow } from "../InlineTaskRunRow";
import { TaskRunRow } from "@/components/task-run-list";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useSearchParams: () => new URLSearchParams(),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  };
});

const MESSAGE =
  "No verdict: 1 of 2 checks got no verdict from the judge (judge error or no judge configured); the other 1 passed.";

function run(overrides: Partial<AgentTaskRunSummary>): AgentTaskRunSummary {
  return {
    id: "run_abc",
    batch_run_id: "batch_1",
    task_id: "support/refund",
    task_path: "support/refund",
    adapter_name: "claude-code",
    status: "error",
    pass_result: null,
    started_at: null,
    completed_at: null,
    total_cost: null,
    total_tokens: null,
    total_checks: 2,
    passed_checks: 1,
    failed_checks: 0,
    errored_checks: 1,
    error_message: MESSAGE,
    trigger: null,
    ...overrides,
  } as unknown as AgentTaskRunSummary;
}

function renderInTable(node: React.ReactNode) {
  return render(
    <table>
      <tbody>{node}</tbody>
    </table>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  [
    "InlineTaskRunRow",
    (r: AgentTaskRunSummary) => (
      <InlineTaskRunRow run={r} projectId="acme" clientNow={null} canDelete={false} onDeleted={() => {}} />
    ),
  ],
  ["TaskRunRow", (r: AgentTaskRunSummary) => <TaskRunRow run={r} projectId="acme" />],
])("%s", (_name, row) => {
  it("renders a judge no-verdict message in warning tone, labelled No verdict", () => {
    renderInTable(row(run({})));
    const message = screen.getByText(MESSAGE.slice(0, 80));
    expect(message.className).toContain("text-warning");
    expect(message.className).not.toContain("text-destructive");
    expect(screen.getByText("No verdict")).toBeInTheDocument();
  });

  it("keeps an executor error's message red", () => {
    renderInTable(row(run({ error_message: "adapter crashed" })));
    expect(screen.getByText("adapter crashed").className).toContain("text-destructive");
    expect(screen.queryByText("No verdict")).not.toBeInTheDocument();
  });
});
