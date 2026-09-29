import { afterEach, describe, expect, it, vi } from "vitest";

// Issue #323: `noVerdict` flows from the aggregate through runTaskDir to the
// standalone CLI, which prints NO VERDICT and exits 2 (errored), not 1.
let _result: { pass: boolean; noVerdict?: true; checks: unknown[] } = { pass: true, checks: [] };

vi.mock("../src/agent-task/task/loadTask", () => ({
  loadTask: vi.fn(async () => ({
    task: { id: "fake-task", deliverables: [], maxTurns: 1 },
    adapter: { name: "fake-adapter" },
    taskDir: "/tmp/fake",
    files: [],
    checksPath: null,
    inlineChecks: true,
    moduleUrl: "file:///tmp/fake/fake.eval.ts",
    evalFileName: "fake.eval.ts",
  })),
}));

vi.mock("../src/agent-task/run/runTask", () => ({
  runTask: vi.fn(async () => ({
    task: { id: "fake-task" },
    taskDir: "/tmp/fake",
    files: [],
    result: _result,
    deliverables: {},
    transcript: { turns: [] },
  })),
}));

const { runTaskDir } = await import("../src/agent-task/task-runtime");
const { runAgentTaskCli } = await import("../src/agent-task/cli");

const JUDGE_ERROR = { id: "memo", pass: false, reasoning: "judge failed: 504", outcome: "error" };

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("no-verdict through runTaskDir and the standalone CLI", () => {
  afterEach(() => {
    _result = { pass: true, checks: [] };
  });

  it("runTaskDir carries noVerdict from the aggregate", async () => {
    _result = { pass: false, noVerdict: true, checks: [JUDGE_ERROR] };
    const summary = await runTaskDir("/tmp/fake");
    expect(summary.pass).toBe(false);
    expect(summary.noVerdict).toBe(true);
  });

  it("the CLI prints NO VERDICT and exits 2", async () => {
    _result = { pass: false, noVerdict: true, checks: [JUDGE_ERROR] };
    const { lines, restore } = captureLog();
    const code = await runAgentTaskCli(["--task", "/tmp/fake"]);
    restore();

    expect(code).toBe(2);
    expect(lines).toContain("NO VERDICT fake-task");
    expect(lines).toContain("- no verdict: 1");
  });

  it("the CLI keeps FAIL and exit 1 for a genuine fail", async () => {
    _result = { pass: false, checks: [{ id: "bad", pass: false, reasoning: "missing" }] };
    const { lines, restore } = captureLog();
    const code = await runAgentTaskCli(["--task", "/tmp/fake"]);
    restore();

    expect(code).toBe(1);
    expect(lines).toContain("FAIL fake-task");
  });
});
