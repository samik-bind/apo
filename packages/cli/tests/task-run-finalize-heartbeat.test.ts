/**
 * Issue #176: `task run` stopped its heartbeat the moment the Task body
 * returned — and only then uploaded file artifacts and POSTed the (8–43 MB)
 * result. Anything slower than the lease TTL in that window got reaped
 * mid-submission, and a completed run with real checks and real agent spend
 * died as `409 lease_stale … cannot finalize result from status 'lost'`.
 *
 * The ordering pinned here, on one unified timeline: the heartbeat lives
 * through artifact upload and result/failure submission (every beat renews
 * the lease server-side) and is stopped only after the terminal POST —
 * never between the Task body and it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One timeline: heartbeat lifecycle events and terminal POSTs land in the
// same array so their relative order is assertable.
const timeline = vi.hoisted(() => ({
  events: [] as string[],
}));

let _throwError: string | null = null;
let _deliverables: Record<string, unknown> = {};

vi.mock("@apo-ai/sdk/agent-task", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@apo-ai/sdk/agent-task")>();
  return {
    ...actual,
    runTaskDir: async () => {
      if (_throwError) throw new Error(_throwError);
      return { taskId: "t", pass: true, checks: [], adapterName: null, traceRunId: null, deliverables: _deliverables };
    },
  };
});

vi.mock("../src/lib/caller-execution.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/caller-execution.ts")>();
  class FakeCallerHeartbeat {
    private stopped = false;
    constructor(
      _backendUrl: string,
      _lease: unknown,
      _onStale: () => void,
      _intervalMs?: number,
    ) {}
    start(_phase: string): void {
      timeline.events.push("heartbeat.start");
    }
    phase(_phase: string): void {}
    /** Idempotent like the real one: only the first stop means anything. */
    async stop(): Promise<void> {
      if (this.stopped) return;
      this.stopped = true;
      timeline.events.push("heartbeat.stop");
    }
  }
  return { ...actual, CallerHeartbeat: FakeCallerHeartbeat };
});

import * as credentials from "../src/lib/credentials.ts";
import { run } from "../src/commands/task-run.ts";

function mockResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function writeTask(root: string): string {
  const taskDir = join(root, "finalize-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "finalize-task.eval.ts"),
    `import { task } from "@apo-ai/sdk/agent-task";\ntask("finalize-task", { adapter: "a" });`,
  );
  return "finalize-task";
}

describe("task run keeps the heartbeat alive through result submission", () => {
  let testDir: string;
  let taskId: string;

  beforeEach(() => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-apo-test",
      project: "proj-test",
    });
    testDir = mkdtempSync(join(tmpdir(), "apo-task-run-finalize-"));
    taskId = writeTask(testDir);
    timeline.events.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
    _throwError = null;
    _deliverables = {};
  });

  function installFetch(resultBehavior: "ok" | "throw" = "ok"): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
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
      if (url.includes("/agent-task-runs/r1/artifact-uploads") && method === "POST") {
        timeline.events.push("artifact-intent");
        return mockResp({ id: "upl_1", upload_url: "/v1/agent-task-artifact-uploads/upl_1" }, 201);
      }
      if (url.includes("/agent-task-artifact-uploads/upl_1") && method === "PUT") {
        timeline.events.push("artifact-put");
        return mockResp({
          id: "dlv_1", name: "report", kind: "artifact", status: "ready",
          media_type: "application/octet-stream", display_filename: "report.docx",
          size_bytes: 15, sha256: "abc", download_url: "/v1/agent-task-runs/r1/deliverables/dlv_1",
        });
      }
      if (url.includes("/attempts/a1/result")) {
        timeline.events.push("result");
        if (resultBehavior === "throw") throw new Error("connection reset mid-upload");
        return mockResp({ status: "succeeded" });
      }
      if (url.includes("/attempts/a1/failure")) {
        timeline.events.push("failure");
        return mockResp({ status: "failed" });
      }
      if (url.includes("/agent-task-runs/r1")) return mockResp({ status: "error" });
      return mockResp({}, 404);
    });
  }

  it("stops the heartbeat only after artifacts are uploaded and the result is submitted", async () => {
    const { fileArtifact } = await import("@apo-ai/sdk/agent-task");
    const artifactPath = join(testDir, "report.docx");
    writeFileSync(artifactPath, "fake-docx-bytes");
    _deliverables = { report: fileArtifact(artifactPath) };
    installFetch("ok");

    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test",
    ]);

    expect(code).toBe(0);
    const events = timeline.events;
    expect(events.indexOf("heartbeat.start")).toBe(0);
    expect(events.indexOf("artifact-put")).toBeGreaterThan(-1);
    expect(events.indexOf("result")).toBeGreaterThan(events.indexOf("artifact-put"));
    // The one assertion that is the fix: the last event is the stop, after
    // the terminal POST — not before the uploads.
    expect(events[events.length - 1]).toBe("heartbeat.stop");
    expect(events.filter((e) => e === "heartbeat.stop")).toHaveLength(1);
  });

  it("keeps the heartbeat alive while the result POST itself fails mid-upload", async () => {
    installFetch("throw");

    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test",
    ]);

    // Outcome unknown after the transport gave up — but the heartbeat was
    // still alive for the attempt, and stopped exactly once afterwards.
    expect(code).toBe(2);
    const events = timeline.events;
    expect(events).toContain("result");
    expect(events[events.length - 1]).toBe("heartbeat.stop");
    expect(events.filter((e) => e === "heartbeat.stop")).toHaveLength(1);
  });

  it("keeps the heartbeat alive through the failure submission when the task throws", async () => {
    _throwError = "task exploded";
    installFetch("ok");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const code = await run([
      taskId, "--dir", testDir, "--backend", "http://backend.test",
      "--project", "proj-test", "--api-key", "sk-apo-test",
    ]);

    expect(code).toBe(2);
    const events = timeline.events;
    expect(events).toContain("failure");
    expect(events[events.length - 1]).toBe("heartbeat.stop");
    expect(events.filter((e) => e === "heartbeat.stop")).toHaveLength(1);
  });
});
