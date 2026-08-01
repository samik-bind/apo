import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Captured at runTaskDir time: the env the CLI threads to the child SDK is the
// caller path's actual contract with it, so it has to be asserted, not assumed.
const _captured: { env?: NodeJS.ProcessEnv } = {};

// Partially mock the SDK: keep the real manifest canonicalizer (used by the
// caller attestation) but stub runTaskDir so the test needs no importable task.
vi.mock("@apo/sdk/agent-task", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@apo/sdk/agent-task")>();
  return {
    ...actual,
    runTaskDir: async () => {
      _captured.env = { ...process.env };
      return { taskId: "t", pass: true, checks: [], adapterName: null, traceRunId: null, deliverables: {} };
    },
  };
});

import * as credentials from "../src/lib/credentials.ts";
import { run } from "../src/commands/task-run.ts";

function mockResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function writeTask(root: string): string {
  const taskDir = join(root, "caller-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "caller-task.eval.ts"),
    `import { task } from "@apo/sdk/agent-task";\ntask("caller-task", { adapter: "a" });`,
  );
  return "caller-task";
}

describe("SPEC-145 task run --executor caller dispatch", () => {
  let testDir: string;
  let taskId: string;

  beforeEach(() => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-apo-test",
      project: "proj-test",
    });
    testDir = mkdtempSync(join(tmpdir(), "apo-task-run-caller-"));
    taskId = writeTask(testDir);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
    _captured.env = undefined;
  });

  it("--executor caller + reachable posts to the caller create route and submits result", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/health")) return new Response("ok", { status: 200 });
      if (url.includes("/agent-task-batch-runs/caller")) {
        return mockResp({
          batch_run_id: "b1", task_run_id: "r1", attempt_id: "a1", lease_generation: 1,
          lease_expires_at: "2026-01-01T00:00:00Z", attempt_jwt: "jwt-1",
          trace_endpoint: "http://backend.test", trace_project: "proj-test",
        }, 201);
      }
      if (url.includes("/attempts/a1/start")) return mockResp({ status: "running" });
      if (url.includes("/attempts/a1/heartbeat")) return mockResp({ cancel_requested: false });
      if (url.includes("/attempts/a1/result")) return mockResp({ status: "succeeded" });
      return mockResp({}, 404);
    });

    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test", "--executor", "caller",
    ]);

    expect(calls.some((u) => u.includes("/v1/agent-task-batch-runs/caller"))).toBe(true);
    expect(calls.some((u) => u.includes("/executor-protocol/v1/attempts/a1/start"))).toBe(true);
    expect(calls.some((u) => u.includes("/executor-protocol/v1/attempts/a1/result"))).toBe(true);
    expect(code).toBe(0);
  });

  // Regression: this path set AGENT_TASK_TRACE_PROJECT, which nothing reads. The
  // SDK gates tracing on AGENT_TASK_PROJECT, so caller runs silently fell back to
  // noop tracing — no trace recorded, and a runtime that nests under a propagated
  // traceparent opened its own unlinked root because no span was ever active. The
  // equivalent local-path assertions existed; this path had none, which is how the
  // two drifted apart.
  it("threads the trace env the SDK actually reads", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/health")) return new Response("ok", { status: 200 });
      if (url.includes("/agent-task-batch-runs/caller")) {
        return mockResp({
          batch_run_id: "b1", task_run_id: "r1", attempt_id: "a1", lease_generation: 1,
          lease_expires_at: "2026-01-01T00:00:00Z", attempt_jwt: "jwt-1",
          // What a proxied server reports about itself: its own loopback default.
          trace_endpoint: "http://127.0.0.1:8000", trace_project: "proj-test",
        }, 201);
      }
      if (url.includes("/attempts/a1/start")) return mockResp({ status: "running" });
      if (url.includes("/attempts/a1/heartbeat")) return mockResp({ cancel_requested: false });
      if (url.includes("/attempts/a1/result")) return mockResp({ status: "succeeded" });
      return mockResp({}, 404);
    });

    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test", "--executor", "caller",
    ]);

    expect(code).toBe(0);
    // The name the SDK reads (task-runtime.ts gates on endpoint && this).
    expect(_captured.env?.AGENT_TASK_PROJECT).toBe("proj-test");
    // A dead name must not come back and look like it is doing something.
    expect(_captured.env?.AGENT_TASK_TRACE_PROJECT).toBeUndefined();
    // The configured, known-reachable backend — NOT the server's self-report. A
    // server behind a reverse proxy defaults to loopback, and trusting it sends the
    // harness's spans to the developer's own machine, leaving a trace that holds
    // only the runtime's spans under a parent that never arrives.
    expect(_captured.env?.AGENT_TASK_TRACE_ENDPOINT).toBe("http://backend.test");
    expect(_captured.env?.AGENT_TASK_RUN_ID).toBe("r1");
    expect(_captured.env?.AGENT_TASK_TRACE_REQUIRED).toBe("true");
    expect(_captured.env?.APO_AUTH_TOKEN).toBe("jwt-1");
  });

  it("--executor caller + unreachable backend exits 2 without recording", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("fail", { status: 503 }));
    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test", "--executor", "caller",
    ]);
    expect(code).toBe(2);
  });

  // SPEC-165 #89 regression: the BARE command (no --executor flag) must
  // route to caller execution. Every previous iteration fixed the decision
  // but not the routing gate, so the default still hit a deleted endpoint.
  it("bare task run (no flags) posts to the caller create-and-claim endpoint", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/health")) return new Response("ok", { status: 200 });
      if (url.includes("/agent-task-batch-runs/caller")) {
        return mockResp({
          batch_run_id: "b1", task_run_id: "r1", attempt_id: "a1", lease_generation: 1,
          lease_expires_at: "2026-01-01T00:00:00Z", attempt_jwt: "jwt-1",
          trace_endpoint: "http://backend.test", trace_project: "proj-test",
        }, 201);
      }
      if (url.includes("/attempts/a1/start")) return mockResp({ status: "running" });
      if (url.includes("/attempts/a1/heartbeat")) return mockResp({ cancel_requested: false });
      if (url.includes("/attempts/a1/result")) return mockResp({ status: "succeeded" });
      return mockResp({}, 404);
    });

    // NO --executor flag, NO --local, NO --remote — just the bare command
    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test",
    ]);

    expect(calls.some((u) => u.includes("/v1/agent-task-batch-runs/caller"))).toBe(true);
    expect(calls.some((u) => u.includes("/v1/agent-task-batch-runs/external"))).toBe(false);
    expect(code).toBe(0);
  });
});
