import { afterEach, describe, expect, it, vi } from "vitest";
import { pollRunVerdict } from "../src/commands/task-run.ts";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const config = {
  backendUrl: "http://localhost:8000",
  apiKey: "test-key",
} as Parameters<typeof pollRunVerdict>[0];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollRunVerdict (issue #174 recovery)", () => {
  it("returns the verdict once the run reaches a terminal status", async () => {
    const statuses = ["running", "running", "passed"];
    const fetchMock = vi.fn(async () => {
      const callIndex = fetchMock.mock.calls.length - 1;
      return mockResponse({ status: statuses[Math.min(callIndex, statuses.length - 1)] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await pollRunVerdict(config, "run_123", 5, 1);
    expect(verdict?.status).toBe("passed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns null after the attempt budget while the run is undecided", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: "running" }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await pollRunVerdict(config, "run_123", 3, 1);
    expect(verdict).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops early on a terminal error — the result never landed", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: "error" }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await pollRunVerdict(config, "run_123", 5, 1);
    expect(verdict).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a recorded no-verdict run — an error run that carries checks (issue #323)", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: "error", total_checks: 3 }));
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await pollRunVerdict(config, "run_123", 5, 1);
    expect(verdict?.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the structured no-verdict reason and message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      mockResponse({ status: "error", total_checks: 0, no_verdict_reason: "generations", error_message: "3 of 4" }),
    ));

    const verdict = await pollRunVerdict(config, "run_123", 1, 1);
    expect(verdict).toEqual({ status: "error", noVerdictReason: "generations", errorMessage: "3 of 4" });
  });

  it("keeps polling through fetch failures within the budget", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error("connection reset");
      return mockResponse({ status: "failed" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await pollRunVerdict(config, "run_123", 5, 1);
    expect(verdict?.status).toBe("failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("polls the run-detail endpoint with auth headers", async () => {
    const fetchMock = vi.fn(async () => mockResponse({ status: "passed" }));
    vi.stubGlobal("fetch", fetchMock);

    await pollRunVerdict(config, "run/needs-encoding", 2, 1);

    const [input, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(input.toString()).toBe(
      "http://localhost:8000/v1/agent-task-runs/run%2Fneeds-encoding",
    );
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
  });
});
