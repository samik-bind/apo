import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/projects-api", () => ({
  listProjects: vi.fn().mockResolvedValue([]),
}));

import { SystemOverview } from "@/components/system/system-overview";
import type {
  AgentTaskRuntimeStatus,
  ReadinessCheckResult,
  ReadinessReport,
  RuntimeConfig,
} from "@/lib/system-api";

const config: RuntimeConfig = {
  backend_url: "http://localhost:8000",
  frontend_url: "http://localhost:3000",
  public_url: "http://localhost:3000",
  database: {
    engine: "sqlite",
    host: null,
    name: "apo.db",
    credentials_configured: true,
    shared_use_recommended: false,
  },
  task_source_cache_dir: "/tmp/task-sources",
  task_execution_mode: "executor_pools",
  scheduler_enabled: true,
  deployment_profile: "development",
  supported_topology: "single-node",
  max_concurrent_batches: 2,
  trusted_task_sources_only: true,
};

const status: AgentTaskRuntimeStatus = {
  available: true,
  node_version: "v22.0.0",
  runner_path: "/opt/runner",
  error: null,
};

function readiness(
  overrides: Record<string, ReadinessCheckResult> = {},
): ReadinessReport {
  const checks: ReadinessReport["checks"] = {
    database: { name: "database", ok: true, detail: null },
    auth_secret: { name: "auth_secret", ok: true, detail: null },
    artifact_store: { name: "artifact_store", ok: true, detail: null },
    ...overrides,
  };
  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

describe("SystemOverview", () => {
  it("shows an all-passing verdict with the check count", () => {
    render(
      <SystemOverview
        initialConfig={config}
        initialReadiness={readiness()}
        initialStatus={status}
      />,
    );
    // 3 readiness checks + the task runtime probe.
    expect(screen.getByText("All 4 checks passing.")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Configuration" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Data" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Maintenance" })).toBeVisible();
  });

  it("surfaces failing checks with their detail in the hero", () => {
    render(
      <SystemOverview
        initialConfig={config}
        initialReadiness={readiness({
          artifact_store: {
            name: "artifact_store",
            ok: false,
            detail: "directory not writable",
          },
        })}
        initialStatus={{ ...status, available: false, error: "runner missing" }}
      />,
    );
    expect(screen.getByText("2 of 4 checks failing.")).toBeVisible();
    expect(screen.getByText(/directory not writable/)).toBeVisible();
    expect(screen.getByText(/runner missing/)).toBeVisible();
  });
});
