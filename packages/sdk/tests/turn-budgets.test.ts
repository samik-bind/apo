/**
 * Turn-scoped duration and token budgets: `t.maxDurationMs(n, { turn })`,
 * `t.maxTokens`, `t.minTokens`.
 *
 * Tokens are the agent's — usage on observations inside `task.turn` spans —
 * so judge work under `checks.run` and adapter setup never count. Budgets fail
 * closed: a sum that is only a lower bound cannot prove a maximum.
 */
import { describe, it, expect } from "vitest";
import {
  defineCheck,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { createProjectionTee } from "../src/agent-task/trace-projection/projection-tee.ts";
import { TraceView } from "../src/agent-task/trace-projection/view.ts";
import { createNoopAgentTaskTraceContext } from "../src/agent-task/tracing.ts";
import type { AgentTaskTraceContext } from "../src/agent-task/tracing.ts";
import type {
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "../src/agent-task/trace-projection/types.ts";

type Obs = TraceProjectionObservation;

function snapshot(
  observations: readonly Obs[],
  capabilities: Partial<TraceProjectionSnapshot["capabilities"]> = {},
): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: {
      traceId: "trace-1",
      startedAt: "2026-09-29T10:00:00Z",
      endedAt: "2026-09-29T10:30:00Z",
      complete: true,
    },
    capabilities: {
      messages: "available",
      tools: "available",
      errors: "available",
      timing: "available",
      skills: "available",
      subagents: "available",
      usage: "available",
      ...capabilities,
    },
    observations,
  };
}

function turnSpan(n: number, durationMs: number): Obs {
  return {
    spanId: `turn-${n}`,
    parentSpanId: "root",
    type: "SPAN",
    name: "task.turn",
    startedAt: `2026-09-29T10:0${n}:00Z`,
    durationMs,
    status: "ok",
  };
}

function llmCall(
  id: string,
  parentSpanId: string,
  usage: Obs["usage"],
  extra: Partial<Obs> = {},
): Obs {
  return {
    spanId: id,
    parentSpanId,
    type: "GENERATION",
    name: "agent-llm-call",
    status: "ok",
    ...(usage !== undefined ? { usage } : {}),
    ...extra,
  };
}

async function runOne(
  check: Parameters<typeof defineCheck>[1],
  snap: TraceProjectionSnapshot,
) {
  resetFlowChecks();
  defineCheck("budget", check);
  const [result] = await runTraceChecks({ snapshot: snap, deliverables: {} });
  return result!;
}

/** Two turns; turn 2's call is nested under a tool span to exercise descent. */
const TWO_TURNS: readonly Obs[] = [
  turnSpan(1, 1_200_000),
  turnSpan(2, 30_000),
  llmCall("g1", "turn-1", { inputTokens: 1000, outputTokens: 200 }),
  llmCall("g2", "turn-1", { inputTokens: 3000, outputTokens: 300 }),
  { spanId: "tool-1", parentSpanId: "turn-2", type: "TOOL", name: "read", status: "ok" },
  llmCall("g3", "tool-1", { inputTokens: 500, outputTokens: 50 }),
  // Evaluation-phase judge usage: not the agent's, never counted.
  { spanId: "checks", parentSpanId: "root", type: "CHAIN", name: "checks.run", status: "ok" },
  llmCall("judge", "checks", { inputTokens: 99_999, outputTokens: 9_999 }),
];

describe("t.maxDurationMs(n, { turn })", () => {
  it("bounds one turn's span duration, not the whole run", async () => {
    const ok = await runOne((t) => t.maxDurationMs(60_000, { turn: 2 }), snapshot(TWO_TURNS));
    expect(ok.pass).toBe(true);

    const slow = await runOne((t) => t.maxDurationMs(600_000, { turn: 1 }), snapshot(TWO_TURNS));
    expect(slow.pass).toBe(false);
    const a = slow.assertions![0]!;
    expect(a.id).toBe("maxDurationMs(600000, turn 1)");
    expect(a.received).toBe("1200000ms");
    expect(a.outcome).not.toBe("unsupported");
  });

  it("fails (not unsupported) when the turn never ran", async () => {
    const r = await runOne((t) => t.maxDurationMs(1000, { turn: 3 }), snapshot(TWO_TURNS));
    expect(r.pass).toBe(false);
    expect(r.assertions![0]!.outcome).not.toBe("unsupported");
    expect(r.assertions![0]!.reasoning).toContain("turn 3 did not run");
  });

  it("is unsupported when timing evidence is unavailable", async () => {
    const r = await runOne(
      (t) => t.maxDurationMs(1000, { turn: 1 }),
      snapshot(TWO_TURNS, { timing: "unavailable" }),
    );
    expect(r.pass).toBe(false);
    expect(r.outcome).toBe("unsupported");
  });

  it("rejects a non-positive or fractional turn as an authoring error", async () => {
    const r = await runOne((t) => t.maxDurationMs(1000, { turn: 0 }), snapshot(TWO_TURNS));
    expect(r.pass).toBe(false);
  });

  it("keeps the whole-run form unchanged without opts", async () => {
    const r = await runOne((t) => t.maxDurationMs(3_600_000), snapshot(TWO_TURNS));
    expect(r.pass).toBe(true);
    expect(r.assertions![0]!.id).toBe("maxDurationMs(3600000)");
  });
});

describe("t.maxTokens / t.minTokens", () => {
  it("sums every turn's usage and excludes judge usage outside the turns", async () => {
    const view = new TraceView(snapshot(TWO_TURNS));
    expect(view.tokens("total")).toEqual({ tokens: 5050, reported: 3, unreported: 0 });
    expect(view.tokens("input", { turn: 1 })?.tokens).toBe(4000);
    expect(view.tokens("output", { turn: 2 })?.tokens).toBe(50);

    const pass = await runOne((t) => t.maxTokens(5050), snapshot(TWO_TURNS));
    expect(pass.pass).toBe(true);

    const fail = await runOne((t) => t.maxTokens(5000), snapshot(TWO_TURNS));
    expect(fail.pass).toBe(false);
    expect(fail.assertions![0]!.received).toBe("5050");
  });

  it("scopes to one turn and one kind", async () => {
    const r = await runOne(
      (t) => {
        t.maxTokens(4000, { turn: 1, kind: "input" });
        t.minTokens(500, { turn: 2 });
      },
      snapshot(TWO_TURNS),
    );
    expect(r.pass).toBe(true);
    expect(r.assertions!.map((a) => a.id)).toEqual([
      "maxTokens(4000, input, turn 1)",
      "minTokens(500, turn 2)",
    ]);
  });

  it("minTokens fails when the agent spent less than the floor", async () => {
    const r = await runOne((t) => t.minTokens(10_000), snapshot(TWO_TURNS));
    expect(r.pass).toBe(false);
    expect(r.assertions![0]!.outcome).not.toBe("unsupported");
  });

  it("an LLM call with no usage makes a maximum unprovable", async () => {
    const obs = [...TWO_TURNS, llmCall("g-unknown", "turn-1", undefined)];
    const r = await runOne((t) => t.maxTokens(1_000_000), snapshot(obs));
    expect(r.pass).toBe(false);
    expect(r.outcome).toBe("unsupported");
    expect(r.assertions![0]!.received).toContain("≥ 5050");
  });

  it("a lower bound still proves a minimum it already reaches", async () => {
    const obs = [...TWO_TURNS, llmCall("g-unknown", "turn-1", undefined)];
    const reached = await runOne((t) => t.minTokens(5000), snapshot(obs));
    expect(reached.pass).toBe(true);

    const notReached = await runOne((t) => t.minTokens(6000), snapshot(obs));
    expect(notReached.pass).toBe(false);
    expect(notReached.outcome).toBe("unsupported");
  });

  it("treats an errored call's count as a lower bound", async () => {
    const obs = [
      ...TWO_TURNS,
      llmCall("g-err", "turn-2", { inputTokens: 0, outputTokens: 0 }, { status: "error" }),
    ];
    const r = await runOne((t) => t.maxTokens(1_000_000), snapshot(obs));
    expect(r.outcome).toBe("unsupported");
  });

  it("treats a total with one dimension missing as a lower bound", async () => {
    const obs = [turnSpan(1, 10), llmCall("g", "turn-1", { inputTokens: 100 })];
    expect(new TraceView(snapshot(obs)).tokens("total")).toEqual({
      tokens: 100,
      reported: 1,
      unreported: 1,
    });
    const r = await runOne((t) => t.maxTokens(1000), snapshot(obs));
    expect(r.outcome).toBe("unsupported");
  });

  it("reads canonical snapshots, where unreported dimensions are null", async () => {
    const obs = [
      turnSpan(1, 10),
      llmCall("g", "turn-1", { inputTokens: 100, outputTokens: null } as unknown as Obs["usage"]),
    ];
    const tally = new TraceView(snapshot(obs)).tokens("input");
    expect(tally).toEqual({ tokens: 100, reported: 1, unreported: 0 });
    expect(new TraceView(snapshot(obs)).tokens("output")?.unreported).toBe(1);
  });

  it("counts usage on a non-GENERATION span, as the run-level rollup does", async () => {
    const obs = [
      turnSpan(1, 10),
      { spanId: "s", parentSpanId: "turn-1", type: "SPAN" as const, name: "agent-llm-call", status: "ok" as const, usage: { inputTokens: 7, outputTokens: 3 } },
    ];
    expect(new TraceView(snapshot(obs)).tokens("total")?.tokens).toBe(10);
  });

  it("is unsupported on a snapshot with no usage capability (written before usage existed)", async () => {
    const snap = snapshot(TWO_TURNS);
    const { usage: _dropped, ...legacyCapabilities } = snap.capabilities;
    const r = await runOne((t) => t.maxTokens(1_000_000), { ...snap, capabilities: legacyCapabilities });
    expect(r.outcome).toBe("unsupported");
    expect(r.assertions![0]!.reasoning).toContain("token usage");
  });

  it("is unsupported, not a vacuous pass, when no LLM call sits inside a turn", async () => {
    const obs = [turnSpan(1, 10), llmCall("judge", "root", { inputTokens: 5, outputTokens: 5 })];
    const r = await runOne((t) => t.maxTokens(1), snapshot(obs));
    expect(r.pass).toBe(false);
    expect(r.outcome).toBe("unsupported");
  });

  it("fails when the requested turn never ran", async () => {
    const r = await runOne((t) => t.maxTokens(1, { turn: 5 }), snapshot(TWO_TURNS));
    expect(r.pass).toBe(false);
    expect(r.assertions![0]!.reasoning).toContain("turn 5 did not run");
  });
});

describe("nesting", () => {
  it("counts a wrapper and the calls it wraps once (canonical Vercel AI SDK shape)", async () => {
    // Canonical: ai.generateText carries the total, each doGenerate its step.
    const obs = [
      turnSpan(1, 10),
      llmCall("wrap", "turn-1", { inputTokens: 1000, outputTokens: 100 }, { name: "ai.generateText" }),
      llmCall("step-a", "wrap", { inputTokens: 600, outputTokens: 60 }, { name: "ai.generateText.doGenerate" }),
      llmCall("step-b", "wrap", { inputTokens: 400, outputTokens: 40 }, { name: "ai.generateText.doGenerate" }),
    ];
    expect(new TraceView(snapshot(obs)).tokens("total")?.tokens).toBe(1100);
    // Local tee: the doGenerate children are dropped, the wrapper alone counts.
    expect(new TraceView(snapshot(obs.slice(0, 2))).tokens("total")?.tokens).toBe(1100);
  });

  it("keeps a child sum that exceeds its parent's own count", async () => {
    const obs = [
      turnSpan(1, 10),
      { spanId: "agent", parentSpanId: "turn-1", type: "AGENT" as const, name: "pi.turn", status: "ok" as const, usage: { inputTokens: 10, outputTokens: 0 } },
      llmCall("g1", "agent", { inputTokens: 500, outputTokens: 50 }),
      llmCall("g2", "agent", { inputTokens: 500, outputTokens: 50 }),
    ];
    expect(new TraceView(snapshot(obs)).tokens("total")?.tokens).toBe(1100);
  });

  it("adds a subagent reached through a tool to the call that ran the tool", async () => {
    // Local processor shape: the outer call carries only its own steps; the
    // subagent's call is a separate call beneath a TOOL span.
    const obs = [
      turnSpan(1, 10),
      llmCall("outer", "turn-1", { inputTokens: 800, outputTokens: 200 }),
      { spanId: "tool", parentSpanId: "outer", type: "TOOL" as const, name: "delegate", status: "ok" as const },
      llmCall("inner", "tool", { inputTokens: 800, outputTokens: 200 }),
    ];
    expect(new TraceView(snapshot(obs)).tokens("total")?.tokens).toBe(2000);
    const r = await runOne((t) => t.maxTokens(1500, { turn: 1 }), snapshot(obs));
    expect(r.pass).toBe(false);
  });

  it("walks a very deep span chain without overflowing the stack", async () => {
    const depth = 20_000;
    const obs: Obs[] = [turnSpan(1, 10)];
    for (let i = 0; i < depth; i++) {
      obs.push({ spanId: `s${i}`, parentSpanId: i === 0 ? "turn-1" : `s${i - 1}`, type: "SPAN", name: "wrap", status: "ok" });
    }
    obs.push(llmCall("leaf", `s${depth - 1}`, { inputTokens: 3, outputTokens: 4 }));
    expect(new TraceView(snapshot(obs)).tokens("total")?.tokens).toBe(7);
  });

  it("does not treat a task.turn span nested inside a turn as a turn of its own", async () => {
    const obs = [
      turnSpan(1, 900_000),
      { ...turnSpan(9, 1), spanId: "nested-turn", parentSpanId: "turn-1", startedAt: "2026-09-29T10:01:30Z" },
      turnSpan(2, 700_000),
      llmCall("g", "nested-turn", { inputTokens: 5, outputTokens: 5 }),
    ];
    const view = new TraceView(snapshot(obs));
    expect(view.turns?.map((t) => t.spanId)).toEqual(["turn-1", "turn-2"]);
    // The nested span's usage still belongs to the enclosing turn.
    expect(view.tokens("total", { turn: 1 })?.tokens).toBe(10);
    const r = await runOne((t) => t.maxDurationMs(10, { turn: 2 }), snapshot(obs));
    expect(r.pass).toBe(false);
    expect(r.assertions![0]!.received).toBe("700000ms");
  });
});

describe("authoring errors", () => {
  it.each([
    ["negative budget", (t: Parameters<Parameters<typeof defineCheck>[1]>[0]) => t.minTokens(-1)],
    ["NaN budget", (t: Parameters<Parameters<typeof defineCheck>[1]>[0]) => t.maxDurationMs(Number.NaN, { turn: 1 })],
    ["unknown kind", (t: Parameters<Parameters<typeof defineCheck>[1]>[0]) =>
      t.maxTokens(10, { kind: "reasoning" as unknown as "total" })],
  ])("rejects a %s instead of recording a verdict", async (_label, check) => {
    const r = await runOne(check, snapshot(TWO_TURNS));
    expect(r.pass).toBe(false);
    expect(r.assertions!.some((a) => a.id === "minTokens(-1)" || a.id.startsWith("maxTokens(") || a.id.startsWith("maxDurationMs("))).toBe(false);
  });
});

/** A real-ish context that issues a unique id per step, like the OTel context. */
function uniqueIdReal(): AgentTaskTraceContext {
  const noop = createNoopAgentTaskTraceContext();
  let n = 0;
  return {
    ...noop,
    runId: "run-1",
    rootSpanId: "root",
    async step(_opts, fn) {
      n += 1;
      return fn(`otel-step-${n}`);
    },
    createSpan() {
      n += 1;
      return `otel-span-${n}`;
    },
  };
}

async function oneTurnThroughTee(real: AgentTaskTraceContext, turns: number) {
  const { trace, getSnapshot } = createProjectionTee(real);
  for (let i = 1; i <= turns; i++) {
    await trace.step({ step_name: "task.turn", metadata: { turnNumber: i } }, async (parentSpanId) => {
      const gen = trace.createSpan({
        step_name: "llm",
        observation_type: "GENERATION",
        parent_call_id: parentSpanId,
      });
      trace.endSpan(gen, { prompt_tokens: 100 * i, completion_tokens: 10 * i });
    });
  }
  return getSnapshot();
}

describe("projection tee", () => {
  it("records usage and attributes it to the turn the step's real id names", async () => {
    const snap = await oneTurnThroughTee(uniqueIdReal(), 2);
    expect(snap.capabilities.usage).toBe("available");
    const view = new TraceView(snap);
    expect(view.turns?.map((t) => t.turnNumber)).toEqual([1, 2]);
    expect(view.tokens("total", { turn: 1 })?.tokens).toBe(110);
    expect(view.tokens("total", { turn: 2 })?.tokens).toBe(220);
  });

  it("marks usage partial when step ids are ambiguous (noop context)", async () => {
    const snap = await oneTurnThroughTee(createNoopAgentTaskTraceContext(), 2);
    expect(snap.capabilities.usage).toBe("partial");
    const r = await runOne((t) => t.maxTokens(1_000_000), snap);
    expect(r.outcome).toBe("unsupported");
  });

  it("records a step's post-hoc usage extractor", async () => {
    const { trace, getSnapshot } = createProjectionTee(uniqueIdReal());
    await trace.step(
      { step_name: "judge", usage: () => ({ prompt_tokens: 4, completion_tokens: 2 }) },
      async () => "verdict",
    );
    const judge = getSnapshot().observations.find((o) => o.name === "judge");
    expect(judge?.usage).toEqual({ inputTokens: 4, outputTokens: 2 });
  });
});
