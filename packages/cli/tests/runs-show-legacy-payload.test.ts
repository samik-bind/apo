import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-show.ts";
import { stripAnsi } from "../src/lib/format.ts";

// `apo runs show` crashed with "Cannot read properties of undefined (reading
// 'toLocaleString')" — even with --json — on runs whose payload predates the
// token rollups, or whose judge segments the backend stored as truncation
// markers (objects, not strings).
const RUN_ID = "0123456789abcdef0123456789abcdef";

const MARKER = { kind: "truncated", preview: "{\"pass\": fal", size_bytes: 40_000, sha256: "ab" };

function legacyRun(): Record<string, unknown> {
  return {
    id: RUN_ID,
    task_id: "legacy",
    task_path: "tasks/legacy",
    batch_run_id: "batch-1",
    adapter_name: "demoAdapter",
    status: "failed",
    pass_result: false,
    started_at: "2026-06-29T10:00:00Z",
    completed_at: "2026-06-29T10:00:03Z",
    trace_run_id: null,
    error_message: null,
    total_cost: null,
    // total_tokens / total_reasoning_tokens / max_call_reasoning_tokens absent
    total_checks: 2,
    passed_checks: 0,
    failed_checks: 2,
    trigger: null,
    checks_json: [
      {
        id: "memo",
        pass: false,
        reasoning: "missing table",
        judge: { model: "m", prompt: { system: MARKER, user: MARKER }, response: MARKER },
        assertions: [
          {
            id: "judge",
            pass: false,
            reasoning: "missing table",
            judge: { model: "m", response: MARKER },
          },
        ],
      },
      {
        id: "tone",
        pass: false,
        reasoning: "too casual",
        judge: { model: "m", response: MARKER },
      },
    ],
    deliverables_json: null,
    transcript_json: null,
  };
}

function capture(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...args: unknown[]) => out.push(args.join(" "));
  console.error = (...args: unknown[]) => out.push(args.join(" "));
  return { out, restore: () => { console.log = log; console.error = err; } };
}

describe("runs show on legacy / marker-bearing payloads", () => {
  afterEach(() => vi.restoreAllMocks());

  it("--json prints the run without crashing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(legacyRun()), { status: 200 }),
    );
    const { out, restore } = capture();
    const code = await run([RUN_ID, "--json", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed.id).toBe(RUN_ID);
    expect(parsed.checks_json[0].judge.response).toEqual(MARKER);
  });

  it("human output renders missing token fields and marker segments", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(legacyRun()), { status: 200 }),
    );
    const { out, restore } = capture();
    const code = await run([RUN_ID, "--verbose", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    const text = stripAnsi(out.join("\n"));
    expect(text).toContain("Run: " + RUN_ID);
    expect(text).not.toContain("Tokens:");
    expect(text).toContain("40,000");
  });
});
