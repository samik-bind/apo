/**
 * `apo runs export <run-id> [--out <file>] [--spans]` — write a run's
 * self-contained JSON bundle to disk.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/commands/runs-export.ts";
import { stripAnsi } from "../src/lib/format.ts";

const FULL_ID = "0123456789abcdef0123456789abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bundle(): Record<string, unknown> {
  return {
    bundle_version: 1,
    exported_at: "2026-08-28T00:00:00Z",
    run_id: FULL_ID,
    run: { status: "failed", task_id: "extract-parties" },
    corrections: [],
    judgments: [{ id: "jdg_1" }],
    deliverables: {
      manifest: [{ id: "d1" }, { id: "d2" }],
      values: { summary: { ok: true } },
      artifacts: {},
    },
    attempt: null,
    task_definition_source: { content_sha256: "a".repeat(64) },
    trace: { trace_ids: ["t1"], calls: [{ id: "c1" }, { id: "c2" }], spans: [] },
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

describe("runs export command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the bundle to --out and prints a summary", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(bundle()));
    const dir = mkdtempSync(join(tmpdir(), "apo-export-"));
    const outPath = join(dir, "run.json");
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--out", outPath]);

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      `/v1/agent-task-runs/${FULL_ID}/export`,
    );
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    expect(written.run_id).toBe(FULL_ID);
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain(outPath);
    expect(out).toContain("extract-parties");
    expect(out).toContain("2 deliverables");
    expect(out).toContain("2 calls");
    expect(out).toContain("eval source");
    restore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes include=spans through as a query param", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ...bundle(), trace: { trace_ids: ["t1"], calls: [], spans: [{}, {}] } }));
    const dir = mkdtempSync(join(tmpdir(), "apo-export-"));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--out", join(dir, "s.json"), "--spans"]);

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("include=spans");
    expect(stripAnsi(logs.join(" "))).toContain("2 spans");
    restore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves 'last' through the shared resolver before exporting", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ id: FULL_ID }]))
      .mockResolvedValueOnce(jsonResponse(bundle()));
    const dir = mkdtempSync(join(tmpdir(), "apo-export-"));

    const code = await run(["last", "--out", join(dir, "l.json")]);

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(
      `/v1/agent-task-runs/${FULL_ID}/export`,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires a run-id argument without fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { logs, restore } = captureLog();

    const code = await run([]);

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.length).toBe(0);
    restore();
  });

  it("maps API errors to exit 2", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Task run not found" }, 404),
    );
    const { logs, restore } = captureError();

    const code = await run([FULL_ID, "--out", "/tmp/should-not-exist.json"]);

    expect(code).toBe(2);
    expect(logs.join(" ")).toMatch(/Task run not found/);
    restore();
  });
});

function captureError(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => (console.error = original) };
}
