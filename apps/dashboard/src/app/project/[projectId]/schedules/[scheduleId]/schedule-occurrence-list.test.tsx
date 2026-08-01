import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ScheduleOccurrenceSummary } from "@/lib/agent-task-api";

vi.mock("@/lib/project-router", () => ({
  useProjectId: () => "acme",
  useIsDemo: () => false,
  DEFAULT_PROJECT: "example-service",
  DEMO_PROJECT: "demo",
}));

import { ScheduleOccurrenceList } from "@/app/project/[projectId]/schedules/[scheduleId]/schedule-occurrence-list";

function occ(
  overrides: Partial<ScheduleOccurrenceSummary>,
): ScheduleOccurrenceSummary {
  return {
    id: "occ-1",
    kind: "scheduled",
    scheduled_for: "2026-08-01T06:00:00Z",
    status: "delivered",
    batch_run_id: "batch-1",
    missed_reason: null,
    resolved_at: null,
    ...overrides,
  };
}

describe("ScheduleOccurrenceList", () => {
  it("uses honest states and never labels a miss as a failed Task result", () => {
    render(
      <ScheduleOccurrenceList
        occurrences={[
          occ({ id: "a", status: "pending", batch_run_id: "b1" }),
          occ({ id: "b", status: "delivered", batch_run_id: "b2" }),
          occ({
            id: "c", status: "missed", batch_run_id: null,
            missed_reason: "previous_occurrence_active",
          }),
          occ({
            id: "d", status: "missed", batch_run_id: null,
            missed_reason: "executor_unavailable",
          }),
          occ({ id: "e", status: "cancelled", batch_run_id: null }),
        ]}
      />,
    );
    expect(screen.getByText(/Queued — waiting to start/i)).toBeInTheDocument();
    expect(screen.getByText(/Ran in the owner/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Missed/i).length).toBe(2);
    expect(screen.getByText(/previous occurrence was still active/i)).toBeInTheDocument();
    expect(
      screen.getByText(/No compatible Connected Executor became available within 24 hours/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Paused before any Task started/i)).toBeInTheDocument();
    // Only the pending + delivered Occurrences own a Batch; misses/cancellations do not.
    expect(screen.getAllByText("view run").length).toBe(2);
  });

  it("links to the Batch only when one exists", () => {
    render(
      <ScheduleOccurrenceList
        occurrences={[occ({ id: "a", status: "delivered", batch_run_id: "batch-x" })]}
      />,
    );
    expect(screen.getByText("view run").getAttribute("href")).toBe(
      "/project/acme/runs/batch-x",
    );
  });

  it("renders an honest empty state", () => {
    render(<ScheduleOccurrenceList occurrences={[]} />);
    expect(screen.getByText(/No occurrences yet/i)).toBeInTheDocument();
  });
});
