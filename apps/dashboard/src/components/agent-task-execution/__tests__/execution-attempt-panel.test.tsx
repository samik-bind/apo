import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ExecutionAttemptSummary } from "@/lib/agent-task-api";
import { ExecutionAttemptPanel } from "../execution-attempt-panel";

function attempt(
  overrides: Partial<ExecutionAttemptSummary>,
): ExecutionAttemptSummary {
  return {
    id: "attempt-1",
    task_run_id: "task-run-1",
    status: "queued",
    phase: null,
    executor_id: null,
    executor_name: null,
    executor_pool_id: "pool-1",
    driver_kind: null,
    queued_at: new Date(Date.now() - 60_000).toISOString(),
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

describe("ExecutionAttemptPanel", () => {
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
          heartbeat_at: new Date().toISOString(),
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
        attempts={[attempt({ status: "lost", failure_kind: "executor_lost" })]}
        poolName="Private VPC"
      />,
    );
    expect(screen.getByText("Executor connection lost")).toBeInTheDocument();
    expect(screen.getByText(/cannot safely infer a result/i)).toBeInTheDocument();
  });

  it("distinguishes queue expiry from generic execution failure", () => {
    render(
      <ExecutionAttemptPanel
        attempts={[attempt({ status: "failed", failure_kind: "executor_unavailable" })]}
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
});
