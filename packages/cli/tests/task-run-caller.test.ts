import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Partially mock the SDK: keep the real manifest canonicalizer (used by the
// caller attestation) but stub runTaskDir so the test needs no importable task.
vi.mock("@apo/sdk/agent-task", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@apo/sdk/agent-task")>();
  return {
    ...actual,
    runTaskDir: async () => ({ taskId: "t", pass: true, checks: [], adapterName: null, traceRunId: null, deliverables: {} }),
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

  it("--executor caller + unreachable backend exits 2 without recording", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("fail", { status: 503 }));
    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test", "--executor", "caller",
    ]);
    expect(code).toBe(2);
  });

  it("--no-record + --executor <pool> is a usage error (exit 2)", async () => {
    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test",
      "--executor", "some-pool", "--no-record",
    ]);
    expect(code).toBe(2);
  });
});
