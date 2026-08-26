import { afterEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../src/lib/format.ts";

/**
 * Regression test for traces-show not forwarding the project query param.
 *
 * The traces-show command hits GET /v1/runs/{id}. The backend defaults
 * project to "default" when no ?project= param is sent, so traces belonging
 * to any other project 404. The fix: forward config.projectId as ?project=,
 * same as traces-list does.
 */

const FULL_ID = "0123456789abcdef0123456789abcdef";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return { errors, restore: () => { console.error = original; } };
}

function makeTraceDetail(): Record<string, unknown> {
  return {
    run: {
      id: FULL_ID,
      task_id: "data-extraction",
      flow_name: "agent-task.data-extraction",
      status: "success",
      duration_ms: 5000,
      environment: "default",
      tags: [],
      created_at: "2026-07-14T18:12:37Z",
      completed_at: "2026-07-14T18:12:42Z",
    },
    calls: [],
    metrics: [],
  };
}

describe("traces show command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards the project query param when projectId is set", async () => {
    const { run } = await import("../src/commands/traces-show.ts");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse(makeTraceDetail()),
    );

    await run([FULL_ID, "--backend", "http://backend.test", "--project", "my-project"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/runs/");
    expect(url).toContain("project=my-project");
  });

  it("returns 404 error when trace is not found", async () => {
    const { run } = await import("../src/commands/traces-show.ts");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({ detail: "Run not found" }, 404),
    );
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--project", "my-project"]);
    restore();

    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Trace not found");
  });
});

describe("traces show model column", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never truncates model names — column sizes to the longest model", async () => {
    // Regression: the model column was hard-sliced to 22 chars, so
    // google/gemini-2.5-flash-lite printed as google/gemini-2.5-flas.
    const longModel = "openrouter/google/gemini-2.5-flash-lite-preview";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      mockResponse({
        run: { id: FULL_ID, status: "success", created_at: "2026-06-29T10:00:00Z" },
        calls: [
          { id: "c1", level: "INFO", step_name: "ai.generateText", model: longModel, latency_ms: 900, cost: 0.0001, total_tokens: 100 },
          { id: "c2", level: "INFO", step_name: "task.turn", model: "gpt-5.6", latency_ms: 100, cost: null, total_tokens: null },
        ],
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain(longModel);
  });
});

describe("traces show evidence + attributes (issue #164)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the projection's evidence capabilities in the header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({
        ...makeTraceDetail(),
        capabilities: {
          messages: "available",
          tools: "available",
          errors: "available",
          timing: "available",
          skills: "unavailable",
          subagents: "unavailable",
        },
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("Evidence:");
    expect(out).toContain("skills:unavailable");
    expect(out).toContain("tools:available");
  });

  it("verbose requests raw span attributes and renders them with the resolved type", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockResponse({
        ...makeTraceDetail(),
        calls: [
          {
            id: "c1", level: "DEFAULT", step_name: "read_file", observation_type: "SKILL",
            model: null, latency_ms: 12, cost: null, total_tokens: null,
            attributes: { "apo.observation.type": "SKILL", "gen_ai.tool.name": "read_file" },
          },
        ],
      }),
    );
    const { logs, restore } = captureLog();
    const { run } = await import("../src/commands/traces-show.ts");

    await run([FULL_ID, "--backend", "http://backend.test", "--verbose"]);
    restore();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("include=messages%2Cattributes");

    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("type: SKILL");
    expect(out).toContain("apo.observation.type");
  });
});
