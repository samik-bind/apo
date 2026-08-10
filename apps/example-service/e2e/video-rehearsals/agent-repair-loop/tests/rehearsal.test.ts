/**
 * rehearsal.test.ts — provider-free contract tests for the agent-repair-loop
 * video rehearsal scenario.
 *
 * No test in this file requires an Apo server, authentication, or a model
 * provider key. The Golden Task's check contract is exercised against
 * deterministic synthetic trace snapshots + deliverables, exactly as the spec's
 * "inject a deterministic flow" acceptance tests require.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTask, discoverAgentTaskDirs } from "@apo-ai/sdk/agent-task";
import { runTraceChecks } from "../../../../../../packages/sdk/src/agent-task/checks/flow-runner.ts";
import type { TraceProjectionSnapshot } from "../../../../../../packages/sdk/src/agent-task/trace-projection/types.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = resolve(TEST_DIR, "..");
const WORK_DIR = join(SCENARIO_DIR, "work");
const TASK_ROOT = join(WORK_DIR, "tasks");
const ANALYTICS_TASK_DIR = join(TASK_ROOT, "analytics-report");
const PREPARE = join(SCENARIO_DIR, "scripts/prepare.mjs");
const VERIFY = join(SCENARIO_DIR, "scripts/verify-workspace.mjs");

const EXPECTED_TEST_NAMES = [
  "used-report-workflow",
  "report-contains-required-metrics",
  "conclusions-are-supported",
  "report-inputs-present",
];

// ── process helpers ──────────────────────────────────────────────────────

function runPrepare() {
  return execFileSync("node", [PREPARE], { encoding: "utf-8", stdio: "pipe" });
}

function runVerifyRaw(args: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [VERIFY, ...args], {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function removeAllWork() {
  rmSync(WORK_DIR, { recursive: true, force: true });
}

beforeEach(() => removeAllWork());
afterEach(() => removeAllWork());

// ── synthetic evidence helpers ───────────────────────────────────────────

type Obs = TraceProjectionSnapshot["observations"][number];

function toolObservation(
  name: string,
  params: Record<string, unknown> | undefined,
  index: number,
): Obs {
  return {
    spanId: `tool-${index}`,
    type: "TOOL",
    name,
    toolName: name,
    toolParameters: params,
    status: "ok",
    startedAt: `2026-08-10T10:00:0${index}Z`,
  };
}

function generationObservation(content: string): Obs {
  return {
    spanId: "gen-1",
    type: "GENERATION",
    name: "generate",
    status: "ok",
    startedAt: "2026-08-10T10:00:09Z",
    messages: [{ role: "assistant", content }],
  };
}

function buildSnapshot(observations: Obs[]): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: {
      traceId: "trace-rehearsal",
      startedAt: "2026-08-10T10:00:00Z",
      endedAt: "2026-08-10T10:00:10Z",
      complete: true,
    },
    capabilities: {
      messages: "available",
      tools: "available",
      errors: "available",
      timing: "available",
      skills: "available",
      subagents: "available",
    },
    observations,
  };
}

/** A full, grounded report containing all five canonical metrics in context. */
const FULL_REPORT = {
  summary:
    "Product analytics report for 2026-W31 (synthetic demo data). " +
    "Active users: 840, a 5% active-user growth over the previous 800. " +
    "30-day retention: 42% (210 of 500). " +
    "Revenue: $126,000, a 5% revenue growth over the previous $120,000.",
  findings: [
    "Active users: 840 (active-user growth 5%)",
    "30-day retention: 42%",
    "Revenue: $126,000 (revenue growth 5%)",
  ],
};

/**
 * Load the prepared Golden Task and run its registered checks against synthetic
 * evidence. The task is loaded exactly once per call (loadTask resets the
 * check registry and reimports the eval).
 */
async function runRehearsalChecks(args: {
  snapshot: TraceProjectionSnapshot;
  deliverables: Record<string, unknown>;
  judge?: { model: string };
}) {
  const loaded = await loadTask(ANALYTICS_TASK_DIR);
  const results = await runTraceChecks({
    snapshot: args.snapshot,
    deliverables: args.deliverables,
    files: loaded.files,
    task: loaded.task,
    judgeConfig: args.judge,
    displayFile: loaded.evalFileName,
  });
  return results;
}

function byId(
  results: { id: string; pass: boolean; reasoning: string }[],
  id: string,
) {
  const found = results.find((r) => r.id === id);
  if (!found) throw new Error(`check '${id}' not registered`);
  return found;
}

// ── Unit tests ───────────────────────────────────────────────────────────

describe("preparation & reset safety", () => {
  it("creates exactly the owned workspace on first prepare", () => {
    expect(existsSync(WORK_DIR)).toBe(false);
    const stdout = runPrepare();

    expect(existsSync(WORK_DIR)).toBe(true);
    expect(existsSync(join(WORK_DIR, "adapter.ts"))).toBe(true);
    expect(existsSync(join(WORK_DIR, "implementation/analytics-report-agent.ts"))).toBe(true);
    expect(existsSync(join(ANALYTICS_TASK_DIR, "analytics-report.eval.ts"))).toBe(true);
    // The workspace contains only real code — no rehearsal meta leaked in.
    expect(existsSync(join(WORK_DIR, "AGENT-PROMPT.md"))).toBe(false);

    const marker = JSON.parse(
      readFileSync(join(WORK_DIR, ".apo-video-rehearsal.json"), "utf-8"),
    );
    expect(marker.scenario).toBe("agent-repair-loop-v1");
    expect(marker.workspace).toBe(WORK_DIR);
    expect(marker.taskId).toBe("analytics-report");
    expect(Object.keys(marker.protectedFiles).sort()).toEqual(
      [
        "adapter.ts",
        "tasks/analytics-report/analytics-report.eval.ts",
        "tasks/analytics-report/files/instructions.md",
        "tasks/analytics-report/files/metrics.json",
      ].sort(),
    );
    // instructions + metrics present
    expect(stdout).toContain("Video rehearsal prepared");
    expect(stdout).toContain(WORK_DIR);
  });

  it("refuses to reset an unowned directory and leaves it byte-for-byte intact", () => {
    mkdirSync(WORK_DIR, { recursive: true });
    const sentinelPath = join(WORK_DIR, "user-file.txt");
    const sentinelContent = "do not delete me";
    writeFileSync(sentinelPath, sentinelContent);

    expect(() => runPrepare()).toThrow();
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(sentinelPath, "utf-8")).toBe(sentinelContent);
  });

  it("resets only an owned workspace: implementation reverts, protected hashes re-match", () => {
    runPrepare();
    // Mutate an allowed implementation file.
    const impl = join(WORK_DIR, "implementation/analytics-report-agent.ts");
    writeFileSync(impl, "// agent repaired this\n");
    const before = readFileSync(impl, "utf-8");
    expect(before).not.toContain("runAnalyticsReport");

    // Re-prepare (reset).
    runPrepare();

    const after = readFileSync(impl, "utf-8");
    expect(after).toContain("runAnalyticsReport");
    // Marker hashes are freshly recorded against the new copy.
    const marker = JSON.parse(
      readFileSync(join(WORK_DIR, ".apo-video-rehearsal.json"), "utf-8"),
    );
    const evalHash = sha256(
      readFileSync(join(ANALYTICS_TASK_DIR, "analytics-report.eval.ts")),
    );
    expect(marker.protectedFiles["tasks/analytics-report/analytics-report.eval.ts"]).toBe(
      evalHash,
    );
  });
});

describe("protected integrity verification", () => {
  it("detects a one-byte mutation in the Golden Task", () => {
    runPrepare();
    const evalPath = join(ANALYTICS_TASK_DIR, "analytics-report.eval.ts");
    const original = readFileSync(evalPath, "utf-8");
    writeFileSync(evalPath, original.replace("analytics-report", "analytics-report "));

    const { status, stdout, stderr } = runVerifyRaw();
    expect(status).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("protected file changed");
  });

  it("allows implementation mutation without an integrity failure", () => {
    runPrepare();
    // A realistic repair: raise the step budget. Keeps the module a valid
    // exporter of runAnalyticsReport.
    const impl = join(WORK_DIR, "implementation/analytics-report-agent.ts");
    const src = readFileSync(impl, "utf-8");
    writeFileSync(impl, src.replace("maxSteps: 1,", "maxSteps: 8,"));

    const { status, stdout } = runVerifyRaw(["--json"]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.protectedFilesIntact).toBe(true);
    expect(payload.startingDefectPresent).toBe(false);
  });
});

describe("Golden Task contract", () => {
  it("has the exact four-Test contract and loads with no model request", async () => {
    runPrepare();
    const loaded = await loadTask(ANALYTICS_TASK_DIR);

    expect(loaded.task.id).toBe("analytics-report");
    expect(loaded.adapter.name).toBe("analytics-report");
    expect(loaded.task.deliverables).toEqual(["result", "tool_log", "stats"]);

    // Recover check ids by running them against empty evidence (no provider).
    const results = await runTraceChecks({
      snapshot: buildSnapshot([]),
      deliverables: { result: { summary: "", findings: [] } },
      files: loaded.files,
      task: loaded.task,
    });
    const names = results.map((r) => r.id);
    expect(names).toEqual(EXPECTED_TEST_NAMES);

    // Both input files are present in the loaded task.
    const relPaths = loaded.files.map((f) => f.relativePath).sort();
    expect(relPaths).toEqual(["instructions.md", "metrics.json"]);
  });

  it("start state fails used-report-workflow specifically because compute was not called", async () => {
    runPrepare();
    // Simulate the maxSteps:2 start state: list_files + read_file happened,
    // compute did NOT. The report has no computed metrics.
    const snapshot = buildSnapshot([
      toolObservation("list_files", undefined, 0),
      toolObservation("read_file", { path: "metrics.json" }, 1),
      generationObservation("I read the files but could not compute anything."),
    ]);
    const deliverables = {
      result: { summary: "Read the files.", findings: [] },
    };

    const results = await runRehearsalChecks({ snapshot, deliverables });
    const workflow = byId(results, "used-report-workflow");
    expect(workflow.pass).toBe(false);
    // The failure must specifically call out compute, not e.g. maxTurns.
    expect(workflow.reasoning).toMatch(/compute/);
  });

  it("a deterministic repaired flow passes all four Tests (judge stubbed to grounded PASS)", async () => {
    runPrepare();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ pass: true, reasoning: "grounded" }) } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = buildSnapshot([
      toolObservation("list_files", undefined, 0),
      toolObservation("read_file", { path: "metrics.json" }, 1),
      toolObservation("compute", { expression: "(840-800)/800" }, 2),
      generationObservation(FULL_REPORT.summary),
    ]);

    const results = await runRehearsalChecks({
      snapshot,
      deliverables: { result: FULL_REPORT },
      judge: { model: "test-judge" },
    });

    vi.unstubAllGlobals();

    for (const id of EXPECTED_TEST_NAMES) {
      expect(byId(results, id).pass, `${id} should pass`).toBe(true);
    }
    // The judge was actually invoked for conclusions-are-supported.
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("controlled-trial prompt contract (template reference)", () => {
  it("permits only implementation edits, bounds the loop, and carries no credentials", () => {
    // The detailed prompt is a template reference for controlled Repair Trials,
    // not something handed to the agent in the workspace (work/ has no
    // AGENT-PROMPT.md). Validate its contract here.
    const prompt = readFileSync(
      join(SCENARIO_DIR, "template/AGENT-PROMPT.md"),
      "utf-8",
    );

    // Implementation-only edits.
    expect(prompt).toMatch(/implementation\/\*\*/);
    expect(prompt).toMatch(/Do not edit[\s\S]*adapter\.ts/);
    expect(prompt).toMatch(/Do not edit[\s\S]*tasks\/\*\*/);

    // Exact Run id discipline + bounded loop.
    expect(prompt).toMatch(/exact (Task )?Run id/i);
    expect(prompt).toMatch(/3 Task Runs/);

    // No credential-like material.
    expect(prompt).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(prompt).not.toMatch(/OPENROUTER_API_KEY\s*=/);
  });
});

// ── Scene / integration tests ────────────────────────────────────────────

describe("scene: maintainer prepare + verify + discover", () => {
  it("prepares, verifies, and discovers analytics-report with four tests (no remote/model call)", async () => {
    runPrepare();

    const { status, stdout } = runVerifyRaw(["--json"]);
    expect(status).toBe(0);
    const payload = JSON.parse(stdout);
    expect(payload.scenario).toBe("agent-repair-loop-v1");
    expect(payload.protectedFilesIntact).toBe(true);
    expect(payload.taskLoaded).toBe(true);
    expect(payload.taskId).toBe("analytics-report");
    expect(payload.testNames).toEqual(EXPECTED_TEST_NAMES);
    expect(payload.startingDefectPresent).toBe(true);

    // Discovery through the public SDK walker (what the CLI uses internally).
    const discovered = discoverAgentTaskDirs(TASK_ROOT);
    expect(discovered).toContain(ANALYTICS_TASK_DIR);
  });

  it("an unowned workspace survives a reset attempt (destructive boundary)", () => {
    // Sentinel inside work/ (unowned) and immediately outside work/.
    mkdirSync(WORK_DIR, { recursive: true });
    const insideSentinel = join(WORK_DIR, "inside.txt");
    const outsideSentinel = join(SCENARIO_DIR, "outside-sentinel.txt");
    writeFileSync(insideSentinel, "inside");
    writeFileSync(outsideSentinel, "outside");

    try {
      expect(() => runPrepare()).toThrow();
      expect(existsSync(insideSentinel)).toBe(true);
      expect(readFileSync(insideSentinel, "utf-8")).toBe("inside");
      expect(existsSync(outsideSentinel)).toBe(true);
      expect(readFileSync(outsideSentinel, "utf-8")).toBe("outside");
    } finally {
      rmSync(outsideSentinel, { force: true });
    }
  });

  it("protected mutation blocks the documented run sequence before any live Task Run", () => {
    runPrepare();
    // Tamper with the Golden Task, then follow the README's verify step.
    const evalPath = join(ANALYTICS_TASK_DIR, "analytics-report.eval.ts");
    const original = readFileSync(evalPath, "utf-8");
    writeFileSync(evalPath, original + "\n// tampered\n");

    const { status, stdout, stderr } = runVerifyRaw();
    expect(status).not.toBe(0);
    expect(`${stdout}${stderr}`).toContain("protected file changed");
  });
});

// ── tiny helpers ─────────────────────────────────────────────────────────

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
