import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ExecutionAttemptSummary } from "@/lib/agent-task-api";
import { ExecutionAttemptPanel } from "../execution-attempt-panel";

// Fixed wall-clock for heartbeat/cancel timestamps so renders are
// deterministic (no `new Date()` at render time). The panel renders relative
// ages from these, but no assertion depends on the age text.
const FIXED_NOW = "2026-08-14T10:00:00.000Z";

function attempt(
  overrides: Partial<ExecutionAttemptSummary>,
): ExecutionAttemptSummary {
  return {
    id: "attempt-1",
    task_run_id: "task-run-1",
    status: "queued",
    phase: null,
    assignment_kind: "bundled",
    executor_id: null,
    executor_name: null,
    executor_pool_id: "pool-1",
    driver_kind: null,
    queued_at: new Date(Date.now() - 60_000).toISOString(),
    queue_expires_at: null,
    waiting_reason: null,
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    completed_at: null,
    failure_kind: null,
    error_message: null,
    cancel_requested_at: null,
    ...overrides,
  };
}

describe("ExecutionAttemptPanel — legacy Pool Runs", () => {
  it("names the exact Pool while queued", () => {
    render(<ExecutionAttemptPanel attempts={[attempt({})]} poolName="Private VPC" />);
    expect(screen.getByText("Waiting for Private VPC")).toBeInTheDocument();
    expect(screen.getByText(/will not move this run to another pool/i)).toBeInTheDocument();
  });

  it("shows Executor, driver, phase, and heartbeat while running", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[attempt({
          status: "running",
          executor_name: "executor-east",
          driver_kind: "subprocess",
          phase: "uploading",
          heartbeat_at: FIXED_NOW,
        })]}
        poolName="Private VPC"
      />,
    );
    expect(screen.getByText("Running on executor-east")).toBeInTheDocument();
    expect(screen.getByText(/Phase: uploading/i)).toBeInTheDocument();
    expect(screen.getByText("subprocess")).toBeInTheDocument();
  });

  it("uses explicit uncertain copy for a lost attempt", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[
          attempt({ id: "attempt-1", task_run_id: "task-run-1", status: "lost", failure_kind: "executor_lost" }),
          attempt({ id: "attempt-2", task_run_id: "task-run-2", status: "queued" }),
        ]}
        poolName="Private VPC"
      />,
    );
    expect(screen.getByText("Executor connection lost")).toBeInTheDocument();
    expect(screen.getByText(/cannot safely infer a result/i)).toBeInTheDocument();
  });

  it("distinguishes queue expiry from generic execution failure", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[
          attempt({ id: "attempt-1", task_run_id: "task-run-1", status: "failed", failure_kind: "executor_unavailable" }),
          attempt({ id: "attempt-2", task_run_id: "task-run-2", status: "queued" }),
        ]}
        poolName="Private VPC"
      />,
    );
    expect(screen.getByText("Executor unavailable")).toBeInTheDocument();
    expect(screen.getByText(/before the queue timeout/i)).toBeInTheDocument();
  });

  it("omits the panel for historical Runs without Attempts", () => {
    const { container } = render(
      <ExecutionAttemptPanel attempts={[]} poolName={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["succeeded", "failed", "lost", "cancelled"] as const)(
    "omits the panel for a lone %s attempt — the task-run table already tells that story",
    (status) => {
      const { container } = render(
        <ExecutionAttemptPanel
          attempts={[attempt({ status })]}
          poolName={null}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("omits the panel when every Task Run finished in exactly one terminal attempt", () => {
    const { container } = render(
      <ExecutionAttemptPanel
        attempts={[
          attempt({ id: "attempt-1", task_run_id: "task-run-1", status: "succeeded" }),
          attempt({ id: "attempt-2", task_run_id: "task-run-2", status: "failed", failure_kind: "timeout" }),
          attempt({ id: "attempt-3", task_run_id: "task-run-3", status: "succeeded" }),
        ]}
        poolName={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps retry history visible when a Task Run has several attempts", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[
          attempt({ id: "attempt-1", task_run_id: "task-run-1", status: "cancelled" }),
          attempt({ id: "attempt-2", task_run_id: "task-run-1", status: "succeeded" }),
        ]}
        poolName={null}
      />,
    );
    expect(screen.getByText("2 attempts")).toBeInTheDocument();
  });
});

describe("ExecutionAttemptPanel — source-owned Runs", () => {
  const sourceOwnedQueueExpiry = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();

  it.each([
    ["ready", /Your connected environment is ready/i],
    ["busy", /Your connected environment is busy/i],
    ["offline", /Waiting for apo connect/i],
    ["not_connected", /Run apo connect in this Task workspace/i],
    ["incompatible", /Update the Apo CLI, then restart apo connect/i],
    ["catalog_mismatch", /Run apo task publish from this Task workspace/i],
  ] as const)(
    "queued source-owned attempt shows actionable copy for %s",
    (_state, expected) => {
      render(
        <ExecutionAttemptPanel
          attempts={[attempt({
            assignment_kind: "source_owned",
            status: "queued",
            waiting_reason: _state,
            queue_expires_at: sourceOwnedQueueExpiry,
          })]}
          poolName={null}
        />,
      );
      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );

  it("never renders Pool, Executor, driver, or machine for source-owned Runs", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[attempt({
          assignment_kind: "source_owned",
          status: "running",
          executor_name: "secret-machine",
          executor_pool_id: "internal-source-owned-pool",
          driver_kind: "source-owned-ts",
          phase: "running",
          heartbeat_at: FIXED_NOW,
        })]}
        poolName="Source-Owned Tasks"
      />,
    );
    expect(screen.queryByText("secret-machine")).not.toBeInTheDocument();
    expect(screen.queryByText("source-owned-ts")).not.toBeInTheDocument();
    expect(screen.queryByText("Source-Owned Tasks")).not.toBeInTheDocument();
    expect(screen.getByText(/Running in your connected environment/i)).toBeInTheDocument();
  });

  it("shows cancellation-pending copy, distinct from a terminal cancelled state", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[attempt({
          assignment_kind: "source_owned",
          status: "running",
          cancel_requested_at: FIXED_NOW,
          heartbeat_at: FIXED_NOW,
        })]}
        poolName={null}
      />,
    );
    expect(screen.getByText(/Cancelling in your connected environment/i)).toBeInTheDocument();
  });

  it("explains the 24-hour executor-unavailable terminal state", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[
          attempt({ id: "attempt-1", task_run_id: "task-run-1", assignment_kind: "source_owned", status: "failed", failure_kind: "executor_unavailable" }),
          attempt({ id: "attempt-2", task_run_id: "task-run-2", status: "queued" }),
        ]}
        poolName={null}
      />,
    );
    expect(
      screen.getByText(/No compatible Connected Executor became available within 24 hours/i),
    ).toBeInTheDocument();
  });

  it("explains the task-removed-from-catalog terminal state", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[
          attempt({ id: "attempt-1", task_run_id: "task-run-1", assignment_kind: "source_owned", status: "failed", failure_kind: "task_not_in_catalog" }),
          attempt({ id: "attempt-2", task_run_id: "task-run-2", status: "queued" }),
        ]}
        poolName={null}
      />,
    );
    expect(
      screen.getByText(/no longer in the published catalog/i),
    ).toBeInTheDocument();
  });
});
