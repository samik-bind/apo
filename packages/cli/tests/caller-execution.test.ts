import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCallerRun,
  startCallerAttempt,
  heartbeatCallerAttempt,
  submitCallerResult,
  type CallerLease,
} from "../src/lib/caller-execution.ts";

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const lease: CallerLease = {
  attemptId: "att-1", generation: 1, token: "jwt-1", expiresAt: "2026-01-01T00:00:00Z",
};

afterEach(() => vi.restoreAllMocks());

describe("caller-execution client", () => {
  it("createCallerRun posts to /agent-task-batch-runs/caller with the API key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResp({
        batch_run_id: "b1", task_run_id: "r1", attempt_id: "a1",
        lease_generation: 1, lease_expires_at: "2026-01-01T00:00:00Z",
        attempt_jwt: "jwt-1", trace_endpoint: "http://cp", trace_project: "p1",
      }, 201),
    );
    const out = await createCallerRun({
      backendUrl: "http://backend.test", apiKey: "sk-1", project: "p1",
      task: { task_id: "t1", task_path: "t1", display_name: "t1", adapter_name: null, has_checks: false },
      environment: "default", runMetadata: null,
      attestation: {
        source_type: "caller_worktree", repository_url: null, base_commit_sha: null,
        dirty: true, content_sha256: "a".repeat(64), task_root_label: "tasks",
        file_count: 1, uncompressed_size_bytes: 1,
      },
      identity: { client: "apo-cli", client_version: "0.1.0", hostname_hash: null,
        ci_provider: null, ci_job_id: null, git_branch: null, os: "linux", architecture: "x64" },
    });
    expect(out.lease.token).toBe("jwt-1");
    expect(out.batchRunId).toBe("b1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://backend.test/v1/agent-task-batch-runs/caller");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-1" });
  });

  it("startCallerAttempt posts to the attempt /start endpoint with the Attempt JWT", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResp({ status: "running" }));
    await startCallerAttempt("http://backend.test", lease);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://backend.test/v1/executor-protocol/v1/attempts/att-1/start");
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer jwt-1" });
  });

  it("heartbeatCallerAttempt returns cancellation state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResp({ cancel_requested: true }));
    const out = await heartbeatCallerAttempt("http://backend.test", lease, "running");
    expect(out.cancelRequested).toBe(true);
  });

  it("submitCallerResult posts the bounded result body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResp({ status: "succeeded" }));
    await submitCallerResult("http://backend.test", lease, {
      completion_id: "c1", pass_result: true, checks: [{ name: "x", pass: true }],
    });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.completion_id).toBe("c1");
    expect(body.pass_result).toBe(true);
  });

  it("createCallerRun throws on non-201", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResp({ detail: "nope" }, 422));
    await expect(createCallerRun({
      backendUrl: "http://x", apiKey: "k", project: "p",
      task: { task_id: "t", task_path: "t", display_name: "t", adapter_name: null, has_checks: false },
      environment: "default", runMetadata: null,
      attestation: { source_type: "caller_worktree", repository_url: null, base_commit_sha: null,
        dirty: false, content_sha256: "b".repeat(64), task_root_label: "t", file_count: 1, uncompressed_size_bytes: 1 },
      identity: { client: "apo-cli", client_version: "0", hostname_hash: null,
        ci_provider: null, ci_job_id: null, git_branch: null, os: "l", architecture: "x" },
    })).rejects.toThrow(/caller create failed: 422/);
  });
});
