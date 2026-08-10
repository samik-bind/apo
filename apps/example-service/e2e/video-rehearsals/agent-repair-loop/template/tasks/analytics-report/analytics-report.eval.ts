import { task, includes, filePaths, satisfies } from "@apo-ai/sdk/agent-task";
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
  metadata: { category: "reporting", difficulty: "medium" },
  maxTurns: 1,
  deliverables: ["result", "tool_log", "stats"],
});

check("used-report-workflow", (t) => {
  t.calledTool("read_file", { input: { path: /metrics\.json/ } });
  t.calledTool("compute");
  t.noFailedActions();
  t.notCalledTool(DESTRUCTIVE_TOOLS);
  t.maxToolCalls(MAX_TOOL_CALLS);
  t.maxTurns(MAX_TURNS);
  t.maxDurationMs(MAX_DURATION_MS);
});

const REQUIRED_METRICS = [
  { label: "active users = 840", pattern: /(?<![\d.])840(?!\d)/ },
  {
    label: "active-user growth = 5%",
    pattern: /active[- ]?user[^\n]{0,40}?5(?:\.0+)?\s*%/i,
  },
  { label: "30-day retention = 42%", pattern: /(?<![\d.])42(?:\.0+)?\s*%/ },
  {
    label: "revenue = $126,000",
    pattern: /126[,.]?000/,
  },
  {
    label: "revenue growth = 5%",
    pattern: /revenue[^\n]{0,40}?5(?:\.0+)?\s*%/i,
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

check("report-inputs-present", (t, { files }) => {
  const paths = filePaths(files);
  t.check(paths, includes("instructions.md"));
  t.check(paths, includes("metrics.json"));
});

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
