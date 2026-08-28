import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../api-client";

describe("apiClient query arrays", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serializes string arrays as repeated keys, not comma-joined", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiClient("/v1/agent-task-runs", {
      query: { task_id: "t1", status: ["passed", "failed"] },
    });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("task_id=t1");
    expect(url).toContain("status=passed&status=failed");
  });

  it("keeps skipping null, undefined, and empty-string values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiClient("/v1/x", {
      query: { a: null, b: undefined, c: "", d: "keep", e: ["x"] },
    });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("d=keep&e=x");
    expect(url).not.toContain("a=");
    expect(url).not.toContain("b=");
    expect(url).not.toContain("c=");
  });
});
