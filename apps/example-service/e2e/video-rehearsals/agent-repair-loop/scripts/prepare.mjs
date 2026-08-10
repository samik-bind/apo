/**
 * prepare.mjs — prepare or reset the agent-repair-loop rehearsal workspace.
 *
 * Safety model (Locked Decisions #2 and #3):
 * - The target is ALWAYS the scenario-owned `work/` directory next to this
 *   script. It is never read from argv, env, $HOME, or any external source.
 * - When `work/` does not exist: create it, copy the template, and record
 *   SHA-256 hashes of every protected file in the ownership marker.
 * - When `work/` exists: replace it ONLY if the ownership marker is present,
 *   names scenario `agent-repair-loop-v1`, and its `workspace` field points at
 *   this exact `work/` directory. Otherwise exit non-zero and touch nothing.
 *
 * `prepare` is both prepare and reset. There is no separate destructive flag.
 */
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCENARIO_ID = "agent-repair-loop-v1";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = resolve(SCRIPT_DIR, "..");
const TEMPLATE_DIR = join(SCENARIO_DIR, "template");
const WORK_DIR = join(SCENARIO_DIR, "work");
const MARKER_PATH = join(WORK_DIR, ".apo-video-rehearsal.json");
const TASK_ROOT_REL = "tasks";

// Paths protected during a Repair Trial (relative to work/). Hashes of these are
// recorded in the ownership marker and verified before any reset and by
// verify-workspace.mjs. NOTE: AGENT-PROMPT.md is deliberately NOT in work/ —
// the workspace must look like a normal codebase, with no manual for the agent
// to read. The coding agent discovers the fix from the Apo verdict.
const PROTECTED_FILES = [
  "adapter.ts",
  "tasks/analytics-report/analytics-report.eval.ts",
  "tasks/analytics-report/files/instructions.md",
  "tasks/analytics-report/files/metrics.json",
];

function fail(message) {
  console.error(`prepare: ${message}`);
  process.exit(1);
}

function sha256(relativePath) {
  const abs = join(WORK_DIR, relativePath);
  const bytes = readFileSync(abs);
  return createHash("sha256").update(bytes).digest("hex");
}

function canResetExisting() {
  if (!existsSync(MARKER_PATH)) {
    return { ok: false, reason: `ownership marker not found at ${MARKER_PATH}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MARKER_PATH, "utf-8"));
  } catch {
    return { ok: false, reason: "ownership marker is not valid JSON" };
  }
  if (parsed.scenario !== SCENARIO_ID) {
    return {
      ok: false,
      reason: `marker scenario is '${parsed.scenario}', expected '${SCENARIO_ID}'`,
    };
  }
  if (resolve(parsed.workspace) !== resolve(WORK_DIR)) {
    return {
      ok: false,
      reason: `marker workspace '${parsed.workspace}' is not this scenario's work/ directory`,
    };
  }
  return { ok: true };
}

function copyTemplate() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });
  cpSync(TEMPLATE_DIR, WORK_DIR, { recursive: true });
  // The workspace must contain only real code — no rehearsal meta. AGENT-PROMPT.md
  // lives in the template as the controlled-trial reference but must not leak
  // into the agent's workspace.
  rmSync(join(WORK_DIR, "AGENT-PROMPT.md"), { force: true });
}

function writeMarker() {
  const protectedFiles = {};
  for (const rel of PROTECTED_FILES) {
    protectedFiles[rel] = sha256(rel);
  }
  const marker = {
    scenario: SCENARIO_ID,
    workspace: WORK_DIR,
    taskRoot: join(WORK_DIR, TASK_ROOT_REL),
    taskId: "analytics-report",
    protectedFiles,
  };
  writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2) + "\n");
}

function printSuccess() {
  console.log("Video rehearsal prepared");
  console.log(`Workspace: ${WORK_DIR}`);
  console.log(`Editable:  work/implementation/`);
  console.log(`Protected: work/adapter.ts, work/tasks/`);
  console.log(`Task root: ${join(WORK_DIR, TASK_ROOT_REL)}`);
  console.log(`Task id:   analytics-report`);
  console.log(`Expected first result: FAIL — used-report-workflow (compute was not called)`);
  console.log("");
  console.log("Suggested prompt for the coding agent (type it — do not hand it a file):");
  console.log(`  The analytics-report agent in ${WORK_DIR} is failing its Apo task.`);
  console.log("  Run it with Apo to see the failure, then fix the implementation so all");
  console.log("  checks pass. Only edit work/implementation/.");
  console.log(`  (set APO_TASK_ROOT=${join(WORK_DIR, TASK_ROOT_REL)})`);
}

function main() {
  if (existsSync(WORK_DIR)) {
    const check = canResetExisting();
    if (!check.ok) {
      fail(
        `refusing to touch existing work/ — ${check.reason}. ` +
          `Remove it manually if you know it is safe.`,
      );
    }
  }

  copyTemplate();
  writeMarker();
  printSuccess();
}

main();
