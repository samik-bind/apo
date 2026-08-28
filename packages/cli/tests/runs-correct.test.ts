/**
 * `apo runs correct <run-id> <test-id> (--pass | --fail | --clear)` —
 * Manual test result corrections.
 *
 * Records a human decision about one recorded top-level Test: effective
 * PASS/FAIL or restore the recorded result. Evidence (Check Report,
 * assertions, judge responses, judgments) is never rewritten.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/commands/runs-correct.ts";
import { stripAnsi } from "../src/lib/format.ts";

const FULL_ID = "0123456789abcdef0123456789abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function corrected(overrides: Record<string, unknown> = {}) {
  return {
    test_id: "report-is-complete",
    recorded_pass: false,
    effective_pass: true,
    correction: {
      id: "cor_abc",
      action: "set_pass",
      pass_result: true,
      reason: "Retention is present in the KPI table; judge missed it",
      corrected_by_user_id: "u1",
      corrected_by_label: "u1@test.com",
      corrected_via: "api_key",
      created_at: "2026-08-25T12:00:00Z",
    },
    run_status: "passed",
    run_pass_result: true,
    total_tests: 3,
    passed_tests: 3,
    failed_tests: 0,
    corrected_tests: 1,
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

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): { url: string; body: unknown } {
  const call = fetchMock.mock.calls.at(-1)!;
  return {
    url: String(call[0]),
    body: JSON.parse(String(call[1]?.body)),
  };
}

describe("runs correct command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a set_pass correction and prints the transition", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(corrected()));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "report-is-complete", "--pass", "--reason", "Retention is present; judge missed the table"]);

    expect(code).toBe(0);
    const req = lastRequest(fetchMock);
    expect(req.url).toContain(`/v1/agent-task-runs/${FULL_ID}/test-result-corrections`);
    expect(req.body).toEqual({
      test_id: "report-is-complete",
      action: "set_pass",
      reason: "Retention is present; judge missed the table",
    });
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("report-is-complete");
    expect(out).toContain("recorded FAIL");
    expect(out).toContain("effective PASS");
    expect(out).toContain("PASSED");
    expect(out).toContain("3/3");
    expect(out).toContain("evidence preserved");
    restore();
  });

  it("sends set_fail with a reason", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(
          corrected({
            effective_pass: false,
            recorded_pass: true,
            correction: { ...corrected().correction, action: "set_fail", pass_result: false },
            run_status: "failed",
            run_pass_result: false,
            passed_tests: 1,
            failed_tests: 2,
          }),
        ),
      );

    const code = await run([FULL_ID, "no-failed-actions", "--fail", "--reason", "The trace contains a failed payment call"]);

    expect(code).toBe(0);
    expect(lastRequest(fetchMock).body).toEqual({
      test_id: "no-failed-actions",
      action: "set_fail",
      reason: "The trace contains a failed payment call",
    });
  });

  it("sends clear without a reason", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(
          corrected({
            effective_pass: false,
            correction: null,
            run_status: "failed",
            run_pass_result: false,
            passed_tests: 2,
            failed_tests: 1,
            corrected_tests: 0,
          }),
        ),
      );

    const code = await run([FULL_ID, "report-is-complete", "--clear"]);

    expect(code).toBe(0);
    expect(lastRequest(fetchMock).body).toEqual({
      test_id: "report-is-complete",
      action: "clear",
    });
  });

  it("resolves 'last' and unique prefixes through the shared resolver", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse([{ id: FULL_ID }]))
      .mockResolvedValueOnce(jsonResponse(corrected()));

    const code = await run(["last", "report-is-complete", "--pass", "--reason", "x".repeat(30)]);

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[1]![0])).toContain(`/v1/agent-task-runs/${FULL_ID}/test-result-corrections`);
  });

  it("supports --json for machine-readable output", async () => {
    const body = corrected();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "report-is-complete", "--pass", "--reason", "x".repeat(30), "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(logs.join(""))).toEqual(body);
    restore();
  });

  it("rejects missing action flags without fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { logs, restore } = captureError();

    const code = await run([FULL_ID, "report-is-complete", "--reason", "x".repeat(30)]);

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/exactly one of/);
    restore();
  });

  it("rejects conflicting action flags without fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { logs, restore } = captureError();

    const code = await run([FULL_ID, "t", "--pass", "--fail", "--reason", "x".repeat(30)]);

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/exactly one of/);
    restore();
  });

  it("requires a reason for pass/fail without fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { logs, restore } = captureError();

    const code = await run([FULL_ID, "t", "--pass"]);

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.join(" ")).toMatch(/--reason/);
    restore();
  });

  it("maps API error kinds to actionable messages with exit 2", async () => {
    for (const [status, detail, match] of [
      [404, { kind: "task_run_not_found" }, /task_run_not_found/],
      [404, { kind: "test_result_not_found" }, /test_result_not_found/],
      [409, { kind: "run_not_correctable", msg: "status is 'running'" }, /run_not_correctable/],
      [409, { kind: "no_active_correction" }, /no_active_correction/],
      [422, { kind: "reason_required" }, /reason_required/],
    ] as const) {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ detail }, status));
      const { logs, restore } = captureError();

      const code = await run([FULL_ID, "t", "--pass", "--reason", "x".repeat(30)]);

      expect(code).toBe(2);
      expect(stripAnsi(logs.join(" "))).toMatch(match);
      restore();
    }
  });

  it("exits 2 with connection errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Cannot connect to backend"));
    const { logs, restore } = captureError();

    const code = await run([FULL_ID, "t", "--pass", "--reason", "x".repeat(30)]);

    expect(code).toBe(2);
    expect(logs.join(" ")).toMatch(/Cannot connect|backend/i);
    restore();
  });
});
