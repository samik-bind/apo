/**
 * `apo batch delete <batch-id> --yes` — permanent batch-run deletion.
 *
 * Same safety story as `runs delete`: --yes gates the DELETE; without it
 * the command names the batch and exits 2.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/batch-delete.ts";
import { stripAnsi } from "../src/lib/format.ts";

const FULL_ID = "0123456789abcdef0123456789abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deleted(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    deleted_runs: 3,
    deleted_traces: 3,
    deleted_calls: 12,
    deleted_batches: 1,
    ...overrides,
  };
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => (console.log = original) };
}

function captureError(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => (console.error = original) };
}

function requests(fetchMock: ReturnType<typeof vi.fn>): Array<{ url: string; method: string }> {
  return fetchMock.mock.calls.map((call) => ({
    url: String(call[0]),
    method: String(call[1]?.method ?? "GET"),
  }));
}

describe("batch delete command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends DELETE for a full batch id with --yes and prints the counts", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(deleted()));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--yes"]);

    expect(code).toBe(0);
    const reqs = requests(fetchMock);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.method).toBe("DELETE");
    expect(reqs[0]!.url).toContain(`/v1/agent-task-batch-runs/${FULL_ID}`);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain(`${FULL_ID} deleted`);
    expect(out).toContain("3 runs");
    expect(out).toContain("3 traces");
    restore();
  });

  it("resolves a unique prefix through the batch list before deleting", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: FULL_ID }] }))
      .mockResolvedValueOnce(jsonResponse(deleted()));

    const code = await run(["012345", "--yes"]);

    expect(code).toBe(0);
    const reqs = requests(fetchMock);
    expect(reqs[0]!.url).toContain("/v1/agent-task-batch-runs");
    expect(reqs[0]!.method).toBe("GET");
    expect(reqs[1]!.method).toBe("DELETE");
    expect(reqs[1]!.url).toContain(`/v1/agent-task-batch-runs/${FULL_ID}`);
  });

  it("without --yes names the batch and exits 2 without deleting", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { logs } = captureLog();
    const { logs: errs, restore } = captureError();

    const code = await run([FULL_ID]);

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stripAnsi(logs.join(" "))).toContain(`${FULL_ID} would be deleted`);
    expect(stripAnsi(errs.join(" "))).toMatch(/--yes/);
    restore();
  });

  it("supports --json for machine-readable output", async () => {
    const body = deleted();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--yes", "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual({ batch_id: FULL_ID, ...body });
    restore();
  });

  it("requires a batch-id argument without fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { logs, restore } = captureError();

    const code = await run(["--yes"]);

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/batch-id/);
    restore();
  });

  it("maps API error kinds to actionable messages with exit 2", async () => {
    for (const [status, detail, match] of [
      [409, "Batch is still active — cancel it before deleting", /cancel it before deleting/],
      [404, "Batch run not found", /Batch run not found/],
      [403, "Project role required: admin", /Project role required/],
    ] as const) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ detail }, status));
      const { logs, restore } = captureError();

      const code = await run([FULL_ID, "--yes"]);

      expect(code).toBe(2);
      expect(stripAnsi(logs.join(" "))).toMatch(match);
      restore();
    }
  });

  it("exits 2 with connection errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Cannot connect to backend"));
    const { logs, restore } = captureError();

    const code = await run([FULL_ID, "--yes"]);

    expect(code).toBe(2);
    expect(logs.join(" ")).toMatch(/Cannot connect|backend/i);
    restore();
  });
});
