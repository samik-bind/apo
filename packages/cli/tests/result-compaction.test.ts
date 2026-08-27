import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SourceOwnedAssignment } from "../src/lib/connected-executor.ts";

/*
 * Result-submission compaction scene test (SPEC-186 / issue #175).
 *
 * Drives connect.ts::executeAssignment against a mocked Control Plane and a
 * stubbed child spawner whose summary carries judged checks with a large
 * ``received`` — the exact shape that produced 43 MB result bodies. Asserts
 * the /result wire body carries the backend's truncation marker instead of
 * the document copies, and that the 20 MB guard stays silent at sane sizes.
 */

const fixedDigest = "sha256:matched";
const fixedHash = "a".repeat(64);

vi.mock("../src/lib/task-meta.ts", () => ({
  discoverTaskMeta: () => [
    { id: "support/refund", path: "/ws/tasks/support/refund", display_name: "refund" },
  ],
}));
vi.mock("../src/lib/task-catalog.ts", () => ({
  toPublishedTask: (t: { id: string }) => ({ task_id: t.id }),
}));
vi.mock("../src/lib/task-catalog-digest.ts", () => ({ computeCatalogDigest: () => fixedDigest }));
vi.mock("../src/lib/task-revision.ts", () => ({
  walkWorkspaceForRevision: () => ({
    contentSha256: fixedHash,
    manifest: { summary: { fileCount: 7, uncompressedSizeBytes: 1234 } },
  }),
}));
vi.mock("../src/lib/git-provenance.ts", () => ({
  readGitProvenance: () => ({
    repositoryUrl: "https://github.com/o/r.git",
    baseCommitSha: "deadbeef",
    dirty: true,
  }),
}));

let childOutcome: {
  ok: boolean;
  summary?: Record<string, unknown>;
  error?: string;
  timedOut?: boolean;
} = { ok: true, summary: { pass: true } };

vi.mock("../src/lib/local-task-child.ts", () => ({
  buildChildEnv: () => ({}),
  runTaskChild: vi.fn(async () => ({
    ok: childOutcome.ok,
    summary: childOutcome.summary,
    error: childOutcome.error,
    timedOut: childOutcome.timedOut ?? false,
    stdoutTail: "",
    stderrTail: "",
  })),
}));

const fetchCalls: { url: string; body: unknown }[] = [];
function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const assignment: SourceOwnedAssignment = {
  assignment_kind: "source_owned",
  attempt_id: "att-1",
  task_run_id: "run-1",
  batch_run_id: "bch-1",
  task_id: "support/refund",
  environment: "default",
  timeout_seconds: 30,
  project: "acme",
  catalog_digest: fixedDigest,
  lease_generation: 1,
  lease_expires_at: "2026-01-01T00:00:00Z",
  attempt_jwt: "attempt-jwt",
  trace_endpoint: "http://cp/otel",
  trace_required: true,
  result_max_bytes: 1024,
  diagnostic_tail_bytes: 100,
  run_metadata: null,
};

const { __executeAssignmentForTest: exec } = await import("../src/commands/connect.ts");
const { warnIfResultBodyLarge } = await import("../src/commands/task-run.ts");

/** 65 criteria judged against the same ~600 KB document — the MSA shape. */
function msaShapedSummary(docBytes: number): Record<string, unknown> {
  const document = "D".repeat(docBytes);
  return {
    pass: true,
    adapterName: "claude-code",
    checks: Array.from({ length: 65 }, (_, i) => ({
      id: `criterion-${i}`,
      pass: true,
      reasoning: "ok",
      assertions: [
        {
          id: "judge",
          pass: true,
          reasoning: "ok",
          received: document,
          evaluator_type: "llm",
        },
      ],
    })),
  };
}

function capturedResult(): Record<string, unknown> {
  return fetchCalls.find((c) => c.url.endsWith("/result"))!.body as Record<string, unknown>;
}

describe("result submission compaction (SPEC-186)", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    childOutcome = { ok: true, summary: { pass: true, adapterName: "claude-code" } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: URL | Request | string, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
      if (url.endsWith("/source-attestation")) return jsonResp({ task_revision_id: "rev-1", content_sha256: "x" });
      if (url.endsWith("/start")) return jsonResp({ attempt_id: "att-1", status: "running", phase: "running" });
      if (url.endsWith("/heartbeat")) return jsonResp({ cancel_requested: false });
      if (url.endsWith("/result")) return jsonResp({ ok: true });
      if (url.endsWith("/failure")) return jsonResp({ ok: true });
      return jsonResp({});
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("replaces oversized judged values with truncation markers on the wire", async () => {
    childOutcome = { ok: true, summary: msaShapedSummary(600 * 1024) };

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);

    const result = capturedResult();
    const checks = result.checks as Array<{ assertions: Array<{ received: unknown }> }>;
    expect(checks).toHaveLength(65);
    for (const check of checks) {
      const received = check.assertions[0].received as Record<string, unknown>;
      expect(received.kind).toBe("truncated");
      expect(received.size_bytes).toBeGreaterThan(600 * 1024);
      expect(typeof received.sha256).toBe("string");
    }
    // All 65 criteria reference the same document → identical markers.
    const first = JSON.stringify(checks[0].assertions[0].received);
    expect(checks.every((c) => JSON.stringify(c.assertions[0].received) === first)).toBe(true);
  });

  it("shrinks the wire body from N × document to ~N × marker", async () => {
    childOutcome = { ok: true, summary: msaShapedSummary(600 * 1024) };

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);

    const wireBytes = JSON.stringify(capturedResult()).length;
    // 65 × 600 KB ≈ 39 MB before; with markers the whole body is tiny.
    expect(wireBytes).toBeLessThan(100 * 1024);
  });

  it("keeps small received values inline on the wire", async () => {
    childOutcome = {
      ok: true,
      summary: {
        pass: true,
        adapterName: "claude-code",
        checks: [
          {
            id: "small",
            pass: true,
            reasoning: "",
            assertions: [{ id: "judge", pass: true, reasoning: "", received: "short value" }],
          },
        ],
      },
    };

    await exec!("http://cp", "/ws", { ...assignment }, new AbortController().signal);

    const checks = capturedResult().checks as Array<{ assertions: Array<{ received: unknown }> }>;
    expect(checks[0].assertions[0].received).toBe("short value");
  });

  it("warns (never fails) when the serialized result body exceeds 20 MB", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const big: Record<string, unknown> = { completion_id: "c", checks: null, transcript: { blob: "t".repeat(21 * 1024 * 1024) } };
      warnIfResultBodyLarge(big as never);
      const small: Record<string, unknown> = { completion_id: "c", checks: null };
      warnIfResultBodyLarge(small as never);
    } finally {
      console.error = original;
    }

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("21.0 MB");
    expect(errors[0]).toContain("> 20 MB");
  });
});
