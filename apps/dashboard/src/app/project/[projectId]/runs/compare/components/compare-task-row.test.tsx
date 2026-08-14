import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { AgentTaskRunDetail } from "@/lib/agent-task-api";

// Mock the heavy code viewer (pulled in via next/dynamic) so the test stays fast.
vi.mock("next/dynamic", () => ({
  __esModule: true,
  default: (loader: () => Promise<unknown>) => {
    const Comp = () => null;
    Comp.displayName = "DynamicComponent";
    return Comp;
  },
}));

// Stub utility imports that CompareTaskRow pulls in but that aren't relevant
// to the evidence-loading behavior under test.
vi.mock("@/lib/load-check-source", () => ({
  loadCheckSource: vi.fn(),
}));
vi.mock("@/lib/agent-task-api", () => ({
  getAgentTaskRun: vi.fn(),
  readTaskDefinitionSource: vi.fn(),
  readTaskFile: vi.fn(),
}));

import { CompareTaskRow } from "./CompareTaskRow";
import type { ComparisonTask } from "../use-comparison";

// ─── helpers ──────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<ComparisonTask> = {}): ComparisonTask {
  return {
    taskId: "task-1",
    label: "Task One",
    folder: "evals",
    differs: true,
    expandable: true,
    state: "aligned",
    left: { run: { id: "run-a", status: "passed", total_checks: 1, passed_checks: 1, failed_checks: 0 } as unknown as ComparisonTask["left"]["run"] },
    right: { run: { id: "run-b", status: "failed", total_checks: 1, passed_checks: 0, failed_checks: 1 } as unknown as ComparisonTask["right"]["run"] },
    ...overrides,
  };
}

const noopToggle = vi.fn();

// ─── tests ────────────────────────────────────────────────────────────────

describe("CompareTaskRow evidence loading (SPEC-177)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading state, then evidence when the loader resolves", async () => {
    const evidenceLoader = vi.fn().mockResolvedValue({
      left: { id: "run-a", checks_json: [] } as unknown,
      right: { id: "run-b", checks_json: [] } as unknown,
    });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
    });
    expect(evidenceLoader).toHaveBeenCalledOnce();
  });

  it("shows error and retry when the evidence loader rejects", async () => {
    const evidenceLoader = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue({ left: { id: "run-a", checks_json: [] }, right: { id: "run-b", checks_json: [] } });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    // Wait for the error state.
    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeInTheDocument();
    });

    // Retry button should be present.
    const retryButton = screen.getByText("Retry");
    expect(retryButton).toBeInTheDocument();

    // "Not run" must NOT appear — this is a load failure, not an absent side.
    // (The "Not run" text only appears in collapsed cells, which are separate
    // from the CheckDiff panel. But verify it doesn't leak.)
    expect(screen.queryAllByText("Not run")).toHaveLength(0);

    // Click retry → loader is called again.
    fireEvent.click(retryButton);
    await waitFor(() => {
      expect(evidenceLoader).toHaveBeenCalledTimes(2);
    });
  });

  it("aborts the evidence request when the task collapses", async () => {
    let capturedSignal: AbortSignal | undefined;

    const evidenceLoader = vi.fn().mockImplementation(
      (_taskId: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never resolves — stays pending
      },
    );

    const { rerender } = render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    expect(evidenceLoader).toHaveBeenCalledOnce();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    // Collapse the task — CheckDiff unmounts, cleanup aborts.
    rerender(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set()}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    expect(capturedSignal!.aborted).toBe(true);
  });

  it("aborts stale evidence when switching to a different task", async () => {
    const signals: AbortSignal[] = [];

    const evidenceLoader = vi.fn().mockImplementation(
      (_taskId: string, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<{ left: unknown; right: unknown }>(() => {});
      },
    );

    const taskA = makeTask({ taskId: "task-a", label: "Alpha" });
    const taskB = makeTask({ taskId: "task-b", label: "Beta" });

    const { rerender } = render(
      <CompareTaskRow
        task={taskA}
        expanded={new Set(["task-a"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    // Switch to task B — task A's CheckDiff unmounts.
    rerender(
      <CompareTaskRow
        task={taskB}
        expanded={new Set(["task-b"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    // First signal (task A) should be aborted.
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].aborted).toBe(true);
  });

  it("does not render a truncated marker as [object Object]", async () => {
    const marker = {
      kind: "truncated" as const,
      preview: "the first 256 chars...",
      size_bytes: 50000,
      sha256: "abc123",
    };

    const evidenceLoader = vi.fn().mockResolvedValue({
      left: {
        id: "run-a",
        checks_json: [
          {
            id: "check-1",
            pass: false,
            name: "quality",
            assertions: [
              {
                id: "a1",
                pass: false,
                judge: {
                  prompt: { system: marker, user: "small" },
                  response: marker,
                },
              },
            ],
          },
        ],
      } as unknown as AgentTaskRunDetail,
      right: {
        id: "run-b",
        checks_json: [
          {
            id: "check-1",
            pass: true,
            name: "quality",
            assertions: [],
          },
        ],
      } as unknown as AgentTaskRunDetail,
    });

    render(
      <CompareTaskRow
        task={makeTask()}
        expanded={new Set(["task-1"])}
        onToggleExpand={noopToggle}
        projectId="proj"
        evidenceLoader={evidenceLoader}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
    });

    // The marker should never appear as raw [object Object] text.
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("[object Object]");
  });
});
