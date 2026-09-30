import { afterEach, describe, expect, it, vi } from "vitest";
import { run as runsList } from "../src/commands/runs-list.ts";
import { run as batchShow } from "../src/commands/batch-show.ts";
import { formatRunResult, isJudgeNoVerdictRun, isNoVerdict } from "../src/lib/checks-format.ts";
import { stripAnsi } from "../src/lib/format.ts";
import type { CheckResult } from "../src/lib/agent-task-types.ts";

// Issue #323: every CLI surface reads a judge no-verdict run from the
// backend's structured `no_verdict_reason` — `runs list` and `batch show`
// agree with `runs show` — and only falls back to the message text for a
// backend that predates the field.
const RULE =
  "No verdict: 1 of 2 checks got no verdict from the judge (judge error or no judge configured); the other 1 passed.";
const ID = "0123456789abcdef0123456789abcdef";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  return { lines, restore: () => { console.log = log; } };
}

function noVerdictRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    task_id: "memo",
    task_path: "tasks/memo",
    batch_run_id: `batch-${ID}`,
    adapter_name: "a",
    status: "error",
    pass_result: null,
    no_verdict_reason: "judge",
    error_message: `${RULE}\nTypeError: caller note`,
    started_at: "2026-06-29T10:00:00Z",
    completed_at: "2026-06-29T10:00:03Z",
    total_cost: null,
    trace_run_id: null,
    total_checks: 2,
    passed_checks: 1,
    failed_checks: 0,
    errored_checks: 1,
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("isJudgeNoVerdictRun", () => {
  const base = { status: "error", pass_result: null, total_checks: 2, failed_checks: 0, errored_checks: 1 };

  it("reads the structured reason, never the message, when the backend sends it", () => {
    expect(isJudgeNoVerdictRun({ ...base, no_verdict_reason: "judge", error_message: "reworded" })).toBe(true);
    expect(isJudgeNoVerdictRun({ ...base, no_verdict_reason: "executor", error_message: RULE })).toBe(false);
    expect(isJudgeNoVerdictRun({ ...base, no_verdict_reason: "generations", error_message: RULE })).toBe(false);
    expect(isJudgeNoVerdictRun({ ...base, no_verdict_reason: null, error_message: RULE })).toBe(false);
    // A recorded verdict wins over a stale reason.
    expect(isJudgeNoVerdictRun({ ...base, no_verdict_reason: "judge", pass_result: false })).toBe(false);
  });

  it("falls back to the rule's message on a backend without the field — not for #149", () => {
    expect(isJudgeNoVerdictRun({ ...base, error_message: RULE })).toBe(true);
    expect(isJudgeNoVerdictRun({ ...base, error_message: "No verdict" })).toBe(false);
    expect(
      isJudgeNoVerdictRun({ ...base, error_message: RULE, generation_execution: { total: 4, errored: 3 } }),
    ).toBe(false);
    // Dominance is the backend's strict majority (errored * 2 > total):
    // half the generations errored is not a #149 run.
    expect(
      isJudgeNoVerdictRun({ ...base, error_message: RULE, generation_execution: { total: 4, errored: 2 } }),
    ).toBe(true);
  });

  it("runs show / list render a run by the reason: NO VERDICT for judge, '-' otherwise", () => {
    const run = { ...base, error_message: "reworded" };
    expect(stripAnsi(formatRunResult({ ...run, no_verdict_reason: "judge" }))).toBe("NO VERDICT");
    expect(formatRunResult({ ...run, no_verdict_reason: "generations" })).toBe("-");
    expect(stripAnsi(formatRunResult({ ...base, pass_result: false, status: "failed" }))).toBe("FAIL");
  });
});

describe("isNoVerdict check roll-up", () => {
  const judge = { id: "j", pass: false, reasoning: "judge failed", outcome: "error" as const };

  it("unsupported-only assertions are a FAIL, not a no verdict", () => {
    const checks: CheckResult[] = [
      {
        id: "t",
        pass: false,
        reasoning: "no timing",
        assertions: [{ id: "u", pass: false, reasoning: "no timing", outcome: "unsupported" }],
      },
    ];
    expect(isNoVerdict(checks)).toBe(false);
  });

  it("a genuine failing assertion beside a judge error keeps FAIL", () => {
    const checks: CheckResult[] = [
      {
        id: "t",
        pass: false,
        reasoning: "missing; judge failed",
        assertions: [{ id: "shape", pass: false, reasoning: "missing field" }, judge],
      },
    ];
    expect(isNoVerdict(checks)).toBe(false);
  });

  it("judge error beside unsupported rolls up to error", () => {
    const checks: CheckResult[] = [
      {
        id: "t",
        pass: false,
        reasoning: "judge failed; no timing",
        assertions: [{ id: "u", pass: false, reasoning: "no timing", outcome: "unsupported" }, judge],
      },
    ];
    expect(isNoVerdict(checks)).toBe(true);
  });
});

describe("runs list / batch show", () => {
  it("runs list prints NO VERDICT for a judge no-verdict run, '-' for an executor error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json([noVerdictRun(), noVerdictRun({ id: `x${ID.slice(1)}`, no_verdict_reason: "executor", error_message: "crash" })]),
    );
    const { lines, restore } = capture();
    await runsList(["--backend", "http://backend.test"]);
    restore();

    const rows = stripAnsi(lines.join("\n")).split("\n");
    expect(rows.find((r) => r.startsWith(ID.slice(0, 4)))).toContain("NO VERDICT");
    expect(rows.find((r) => r.startsWith("x"))).not.toContain("NO VERDICT");
  });

  it("batch show prints NO VERDICT and the rule's line, not the caller's suffix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      json({
        id: `batch-${ID}`,
        project: "p",
        status: "completed",
        total_tasks: 1,
        passed_tasks: 0,
        failed_tasks: 0,
        errored_tasks: 1,
        total_cost: null,
        created_at: "2026-06-29T10:00:00Z",
        started_at: null,
        completed_at: null,
        trigger: null,
        task_runs: [noVerdictRun()],
      }),
    );
    const { lines, restore } = capture();
    await batchShow([`batch-${ID}`, "--backend", "http://backend.test"]);
    restore();

    const out = stripAnsi(lines.join("\n"));
    expect(out).toContain("NO VERDICT memo");
    expect(out).toContain(RULE);
    expect(out).not.toContain("TypeError: caller note");
  });
});
