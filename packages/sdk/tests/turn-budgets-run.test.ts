/**
 * Token budgets through a real `runTask` on the local projection: LLM calls
 * captured through the active run context (what `ApoSpanProcessor` does for
 * zero-config OTel instrumentation) must be attributed to the turn they ran
 * in, not to the run root.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { basename, join } from "path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { runTask } from "../src/agent-task/run/runTask";
import type { TraceStepOptions } from "../src/types.ts";

const TMP_ROOT = join(import.meta.dirname, "__turn_budgets_run_test__");
const LOCAL_DEFINE_TASK_IMPORT = "../../../src/agent-task/task/defineTask";
const LOCAL_DEFINE_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";
const LOCAL_PUBLIC_IMPORT = "../../../src/agent-task/public";

let taskDir = "";
let stepCounter = 0;

const traceRun = vi.fn(async (_params: unknown, fn: (trace: object) => Promise<unknown>) =>
  fn({
    runId: "trace-run-budgets",
    rootSpanId: "root-span",
    async step(_options: TraceStepOptions, stepFn: (spanId: string) => Promise<unknown>) {
      stepCounter += 1;
      return stepFn(`real-step-${stepCounter}`);
    },
    recordEvent() {
      return "event-1";
    },
    endRoot() {},
    createSpan() {
      stepCounter += 1;
      return `real-span-${stepCounter}`;
    },
    endSpan() {},
    traceTool<T>(_name: string, _params: Record<string, unknown>, fn: () => Promise<T>) {
      return fn();
    },
  }),
);

function writeTask(checks: string): void {
  writeFileSync(
    join(taskDir, `${basename(taskDir)}.eval.ts`),
    `
import { defineTask } from "${LOCAL_DEFINE_TASK_IMPORT}";
import { budgetAdapter } from "./adapter";

export default defineTask(budgetAdapter, {
  id: "budget-task",
  description: "Turn budget task",
  deliverables: ["answer"],
  maxTurns: 2,
});
`,
  );
  writeFileSync(
    join(taskDir, "adapter.ts"),
    `
import { z } from "zod";
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";
import { getActiveApoRun } from "${LOCAL_PUBLIC_IMPORT}";

export const budgetAdapter = defineAdapter({
  name: "budget-adapter",
  deliverables: { answer: z.string() },
  turn: async ({ transcript }) => (transcript.length < 2 ? "go" : null),
  async startSession() {
    return {
      async sendUserTurn(_turn: unknown, { turnNumber }: { turnNumber: number }) {
        // What ApoSpanProcessor.onStart does for a top-level GenAI span.
        const run = getActiveApoRun()!;
        const id = run.trace.createSpan({
          step_name: "agent.generate",
          observation_type: "GENERATION",
          parent_call_id: run.parentSpanId ?? run.trace.rootSpanId,
        });
        run.trace.endSpan(id, {
          prompt_tokens: 1000 * turnNumber,
          completion_tokens: 100 * turnNumber,
        });
        return { response: "ok" };
      },
    };
  },
  async collectDeliverables() {
    return { answer: "done" };
  },
});
`,
  );
  writeFileSync(join(taskDir, "checks.ts"), checks);
}

beforeEach(() => {
  stepCounter = 0;
  traceRun.mockClear();
  taskDir = join(TMP_ROOT, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(taskDir, { recursive: true });
});

afterAll(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("token budgets through runTask", () => {
  it("attributes run-context-captured calls to the turn they ran in", async () => {
    writeTask(`
import { test } from "${LOCAL_PUBLIC_IMPORT}";

test("turn-1-budget", (t) => t.maxTokens(1100, { turn: 1 }));
test("turn-2-floor", (t) => t.minTokens(2200, { turn: 2 }));
test("run-total", (t) => t.maxTokens(3300));
test("run-total-too-low", (t) => t.maxTokens(3299));
`);
    const result = await runTask(taskDir, {
      tracing: { client: { traceRun }, project: "sdk-tests" },
    });

    const byName = Object.fromEntries(result.result.checks.map((c) => [c.id, c]));
    expect(byName["turn-1-budget"]!.pass).toBe(true);
    expect(byName["turn-2-floor"]!.pass).toBe(true);
    expect(byName["run-total"]!.pass).toBe(true);
    expect(byName["run-total-too-low"]!.pass).toBe(false);
    expect(byName["run-total-too-low"]!.outcome).not.toBe("unsupported");
  });
});
