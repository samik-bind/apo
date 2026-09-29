import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #323: a run whose only failing checks got no answer from the judge
// prints NO VERDICT and exits 2 (errored), not FAIL / 1. The SDK result is
// stubbed; the CLI derives the verdict from check outcomes so it holds even
// against SDKs that predate `noVerdict`.
let _checks: Array<Record<string, unknown>> = [];

vi.mock("@apo-ai/sdk/agent-task", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@apo-ai/sdk/agent-task")>();
  return {
    ...actual,
    runTaskDir: async () => ({
      taskId: "t", pass: false, checks: _checks, adapterName: null, traceRunId: null,
      deliverables: {},
    }),
  };
});

import * as credentials from "../src/lib/credentials.ts";
import { run } from "../src/commands/task-run.ts";
import { stripAnsi } from "../src/lib/format.ts";

const OK = { id: "ok", pass: true, reasoning: "passed" };
const JUDGE_ERROR = { id: "memo", pass: false, reasoning: "judge failed: 504", outcome: "error" };
const GENUINE_FAIL = { id: "tone", pass: false, reasoning: "too casual" };

function mockResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  return { lines, restore: () => { console.log = log; } };
}

describe("task run no-verdict result (issue #323)", () => {
  let testDir: string;
  let resultBody: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-apo-test",
      project: "proj-test",
    });
    testDir = mkdtempSync(join(tmpdir(), "apo-task-run-no-verdict-"));
    const taskDir = join(testDir, "nv-task");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "nv-task.eval.ts"),
      `import { task } from "@apo-ai/sdk/agent-task";\ntask("nv-task", { adapter: "a" });`,
    );
    resultBody = undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("/health")) return new Response("ok", { status: 200 });
      if (url.includes("/agent-task-batch-runs/caller")) {
        return mockResp({
          batch_run_id: "b1", task_run_id: "r1", attempt_id: "a1", lease_generation: 1,
          lease_expires_at: "2026-01-01T00:00:00Z", attempt_jwt: "jwt-1",
          trace_endpoint: "http://backend.test", trace_project: "proj-test",
        }, 201);
      }
      if (url.includes("/attempts/a1/start")) return mockResp({ status: "running" });
      if (url.includes("/attempts/a1/heartbeat")) return mockResp({ cancel_requested: false });
      if (url.includes("/attempts/a1/result")) {
        resultBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return mockResp({ status: "succeeded" });
      }
      return mockResp({}, 404);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  const args = (): string[] => [
    "nv-task", "--dir", testDir, "--backend", "http://backend.test",
    "--project", "proj-test", "--api-key", "sk-apo-test",
  ];

  it("prints NO VERDICT and exits 2 when only judge errors fail", async () => {
    _checks = [OK, JUDGE_ERROR];
    const { lines, restore } = captureStdout();
    const code = await run(args());
    restore();

    const out = stripAnsi(lines.join("\n"));
    expect(code).toBe(2);
    expect(out).toContain("NO VERDICT t");
    expect(out).not.toMatch(/^FAIL /m);
    // The backend decides the recorded verdict from the checks.
    expect(resultBody?.pass_result).toBe(false);
  });

  it("keeps FAIL and exit 1 when a genuine fail sits beside a judge error", async () => {
    _checks = [JUDGE_ERROR, GENUINE_FAIL];
    const { lines, restore } = captureStdout();
    const code = await run(args());
    restore();

    expect(code).toBe(1);
    expect(stripAnsi(lines.join("\n"))).toContain("FAIL t");
  });

  it("--json carries noVerdict", async () => {
    _checks = [JUDGE_ERROR];
    const { lines, restore } = captureStdout();
    const code = await run([...args(), "--json"]);
    restore();

    expect(code).toBe(2);
    const json = lines.find((line) => line.startsWith("{"));
    const parsed = JSON.parse(json ?? "") as { pass: boolean; noVerdict?: boolean };
    expect(parsed.pass).toBe(false);
    expect(parsed.noVerdict).toBe(true);
  });

  it("--no-record exits 2 on no verdict", async () => {
    _checks = [JUDGE_ERROR];
    const { restore } = captureStdout();
    const code = await run([...args(), "--no-record"]);
    restore();

    expect(code).toBe(2);
  });
});
