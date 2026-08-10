/**
 * analytics-report — the Golden Task for the agent-repair-loop video rehearsal.
 *
 * This file is part of a disposable rehearsal workspace. It is NOT the
 * canonical newcomer example and is intentionally never imported by the main
 * example service. The starting implementation copied alongside it contains a
 * deliberate orchestration defect (see work/implementation/).
 *
 * The suite is intentionally layered the same way as the canonical
 * data-extraction task:
 *
 *   1. Trajectory (deterministic) — the right tools ran in the right order.
 *   2. Facts (deterministic) — the report contains the computed metrics.
 *   3. Judge (one focused LLM judge) — conclusions are supported by the data.
 *   4. Fixture sanity — both input files are present.
 *
 * Loading this file makes no model request. The deterministic layers (1, 2, 4)
 * stay useful even when the judge provider is unavailable.
 */
import {
  task,
  includes,
  filePaths,
  satisfies,
} from "@apo-ai/sdk/agent-task";
import { analyticsReportAdapter } from "../../adapter.ts";

// Anti-flail ceilings shared with the trajectory check. The task's own
// `maxTurns` config is what caps the run; these catch a runaway agent.
const MAX_TURNS = 10;
const MAX_DURATION_MS = 5 * 60 * 1000;
const MAX_TOOL_CALLS = 40;

// Destructive tools a read-only report agent must never invoke.
const DESTRUCTIVE_TOOLS = /^(write_file|delete_file|edit)$/;

const { test: check } = task("analytics-report", {
  adapter: analyticsReportAdapter,
  description: "Produce an evidence-grounded product analytics report.",
  metadata: { category: "video-rehearsal", difficulty: "medium" },
  maxTurns: 1,
  deliverables: ["result", "tool_log", "stats"],
});

// ── Layer 1: trajectory ──────────────────────────────────────────────────
// The required report workflow is list_files -> read_file(metrics.json) ->
// compute -> final report. With the rehearsal's starting step budget, compute
// cannot occur, so this check deterministically FAILS on a fresh workspace —
// the visible gap the coding agent must close.
check("used-report-workflow", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /metrics\.json/ } });
  t.calledTool("compute");
  t.noFailedActions();
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
});

// ── Layer 2: objective, computed facts ───────────────────────────────────
// Deterministic matchers over the final report. Each requires its metric to
// appear in context so the two 5% growth figures and the 42% retention figure
// are distinguishable — not merely the bare tokens.
const REQUIRED_METRICS = [
  { label: "active users = 840", pattern: /840/ },
  {
    label: "active-user growth = 5%",
    pattern: /(active[- ]?user[\s\S]{0,80}?5\s*%)|(5\s*%[\s\S]{0,80}?active[- ]?user)/i,
  },
  { label: "30-day retention = 42%", pattern: /42\s*%/ },
  {
    label: "revenue = $126,000",
    pattern: /126[,.]?000/,
  },
  {
    label: "revenue growth = 5%",
    pattern: /(revenue[\s\S]{0,80}?5\s*%)|(5\s*%[\s\S]{0,80}?revenue)/i,
  },
] as const;

check("report-contains-required-metrics", (t, { deliverables }) => {
  const report = reportText(deliverables.result);
  for (const metric of REQUIRED_METRICS) {
    t.check(
      report,
      satisfies(
        (v: string) => metric.pattern.test(v),
        `report includes ${metric.label}`,
      ),
      `report includes ${metric.label}`,
    );
  }
});

// ── Layer 3: judged quality (one focused judge) ──────────────────────────
// Are the report's conclusions supported by the supplied metrics? This is the
// subjective dimension code cannot assess. It fails unsupported causal claims
// (e.g. "retention fell because onboarding is broken") the fixture has no
// evidence for. Numbers themselves are pinned by Layer 2, not this judge.
check("conclusions-are-supported", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result,
    "PASS if every conclusion in the report is supported by the supplied " +
      "metrics, every computed change (growth, retention) is described " +
      "accurately, and the report does not invent causal explanations. " +
      "FAIL if any conclusion is unsupported — for example a claim that " +
      "'retention fell because onboarding is broken' when no onboarding " +
      "evidence exists in the inputs.",
  );
});

// ── Layer 4: fixture sanity ──────────────────────────────────────────────
check("report-inputs-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("instructions.md"));
  t.check(paths, includes("metrics.json"));
});

/**
 * Flatten the `result` deliverable into one searchable string. The deliverable
 * shape is the validated `{ summary, findings }` form shared with the canonical
 * example service — not a video-only format.
 */
function reportText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as { summary?: unknown; findings?: unknown };
    const summary = typeof r.summary === "string" ? r.summary : "";
    const findings = Array.isArray(r.findings)
      ? r.findings.filter((f): f is string => typeof f === "string").join("\n")
      : "";
    return `${summary}\n${findings}`;
  }
  return "";
}
