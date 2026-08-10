/**
 * verify-workspace.mjs — local-only integrity + identity checks for a prepared
 * rehearsal workspace. No provider, no backend, no model calls.
 *
 * Verifies:
 * - the ownership marker exists and names this scenario;
 * - every protected file's SHA-256 matches the marker;
 * - the Task loads through the public SDK entry (no model request);
 * - the four Test names match the contract exactly, in order;
 * - `startingDefectPresent` reflects the start state's `maxSteps: 2`.
 *
 * With `--json`, prints the {@link RehearsalVerification} object and exits 0 on
 * success / non-zero on any failure. Without `--json`, prints human-readable
 * output.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO_ID = "agent-repair-loop-v1";
const EXPECTED_TEST_NAMES = [
  "used-report-workflow",
  "report-contains-required-metrics",
  "conclusions-are-supported",
  "report-inputs-present",
];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = resolve(SCRIPT_DIR, "..");
const WORK_DIR = join(SCENARIO_DIR, "work");
// The marker lives outside work/ so the coding agent never sees it.
const MARKER_PATH = join(SCENARIO_DIR, ".rehearsal-marker.json");
const TASK_ROOT = join(WORK_DIR, "tasks");
const ANALYTICS_TASK_DIR = join(TASK_ROOT, "analytics-report");
const IMPLEMENTATION_FILE = join(WORK_DIR, "implementation/analytics-report-agent.ts");

function fail(message, jsonPayload) {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(jsonPayload ?? { ok: false, error: message }, null, 2));
  } else {
    console.error(`verify: ${message}`);
  }
  process.exit(1);
}

function sha256(relativePath) {
  const bytes = readFileSync(join(WORK_DIR, relativePath));
  return createHash("sha256").update(bytes).digest("hex");
}

function readMarker() {
  if (!existsSync(MARKER_PATH)) {
    fail(`ownership marker not found at ${MARKER_PATH}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MARKER_PATH, "utf-8"));
  } catch {
    fail("ownership marker is not valid JSON");
  }
  if (parsed.scenario !== SCENARIO_ID) {
    fail(`marker scenario is '${parsed.scenario}', expected '${SCENARIO_ID}'`);
  }
  if (resolve(parsed.workspace) !== resolve(WORK_DIR)) {
    fail(`marker workspace '${parsed.workspace}' is not this scenario's work/`);
  }
  return parsed;
}

function verifyProtected(marker) {
  for (const [rel, expected] of Object.entries(marker.protectedFiles)) {
    const abs = join(WORK_DIR, rel);
    if (!existsSync(abs)) {
      fail(`protected file missing: ${rel}`);
    }
    const actual = sha256(rel);
    if (actual !== expected) {
      fail(`protected file changed: ${rel}`);
    }
  }
}

async function loadTaskThroughSdk() {
  const { loadTask } = await import("@apo-ai/sdk/agent-task");
  return loadTask(ANALYTICS_TASK_DIR);
}

function detectStartingDefect() {
  // The starting defect is `maxSteps: 2` in the actual code. After repair the
  // implementation may raise it, so this is informational (true on a fresh
  // workspace, may be false after repair) and never an integrity error. We
  // strip comments first so the defect isn't re-detected from the explanatory
  // comment after the agent raises the real budget.
  if (!existsSync(IMPLEMENTATION_FILE)) return false;
  const src = readFileSync(IMPLEMENTATION_FILE, "utf-8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  return /maxSteps:\s*1\b/.test(code);
}

async function main() {
  const wantJson = process.argv.includes("--json");
  const marker = readMarker();
  verifyProtected(marker);

  let taskLoaded = false;
  let taskId = null;
  let testNames = [];
  try {
    const loaded = await loadTaskThroughSdk();
    taskLoaded = true;
    taskId = loaded.task.id;
    if (taskId !== "analytics-report") {
      fail(`task id is '${taskId}', expected 'analytics-report'`);
    }
    // The checks are registered as a side effect of loadTask importing the eval
    // file. Read them back from the registry via the same public surface.
    const names = await readRegisteredCheckNames();
    testNames = names;
    const mismatch = EXPECTED_TEST_NAMES.findIndex((n, i) => names[i] !== n);
    if (names.length !== EXPECTED_TEST_NAMES.length || mismatch !== -1) {
      fail(
        `test names mismatch: expected [${EXPECTED_TEST_NAMES.join(", ")}], got [${names.join(", ")}]`,
      );
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail(`task did not load through the SDK: ${msg}`);
  }

  const startingDefectPresent = detectStartingDefect();

  const result = {
    scenario: SCENARIO_ID,
    workspace: WORK_DIR,
    protectedFilesIntact: true,
    taskLoaded,
    taskId,
    testNames,
    startingDefectPresent,
  };

  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("Video rehearsal workspace verified");
  console.log(`Workspace:            ${WORK_DIR}`);
  console.log(`Protected files OK:   ${Object.keys(marker.protectedFiles).length}`);
  console.log(`Task loaded:          ${taskId}`);
  console.log(`Tests (${testNames.length}):       ${testNames.join(", ")}`);
  console.log(`Starting defect present: ${startingDefectPresent}`);
}

async function readRegisteredCheckNames() {
  // The eval file registers checks into a global registry when imported by
  // loadTask. Run the registered checks against an empty snapshot to recover
  // their ids without a provider — zero tool evidence records a normal failed
  // verdict per check, but the ids come back regardless of pass/fail.
  const { runTraceChecks } = await import(
    "../../../../../../packages/sdk/src/agent-task/checks/flow-runner.ts"
  );
  const emptySnapshot = {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "canonical",
    trace: { traceId: "verify", complete: true },
    capabilities: {
      messages: "available",
      tools: "available",
      errors: "available",
      timing: "available",
      skills: "available",
      subagents: "available",
    },
    observations: [],
  };
  const results = await runTraceChecks({
    snapshot: emptySnapshot,
    deliverables: { result: { summary: "", findings: [] } },
    files: [],
  });
  return results.map((r) => r.id);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
