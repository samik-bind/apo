import { existsSync, readFileSync } from "fs";
import { hostname } from "os";
import { resolve } from "path";
import { getBoolFlag, parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig, type Config } from "../lib/config.ts";
import { apiGet, apiPost, isBackendReachable } from "../lib/api.ts";
import { discoverTaskMeta, findTaskMetaById } from "../lib/task-meta.ts";
import { bold, dim, formatJson, formatTime, passFail, formatTrigger, red } from "../lib/format.ts";
import type { CheckResult } from "../lib/agent-task-types.ts";
import { formatChecks, NO_CHECKS_REGISTERED_MESSAGE } from "../lib/checks-format.ts";
type TaskExecutionPreference = "local" | "backend" | "auto";
import {
  resolveExecutionMode,
  type ExecutionReason,
} from "../lib/execution-mode.ts";
import { resolveExecutionTarget } from "../lib/execution-target.ts";
import { walkWorkspaceForRevision } from "../lib/task-revision.ts";
import { prepareTaskDefinition } from "../lib/task-definition.ts";
import { readGitProvenance, buildCallerIdentity } from "../lib/git-provenance.ts";
import {
  createCallerRun,
  startCallerAttempt,
  submitCallerResult,
  submitCallerFailure,
  CallerHeartbeat,
} from "../lib/caller-execution.ts";

type LocalRunSummary = {
  taskId: string;
  pass: boolean;
  checks: CheckResult[];
  adapterName?: string;
  traceRunId?: string;
  deliverables?: Record<string, unknown>;
  transcript?: Record<string, unknown>;
  runConfiguration?: { model: string; effort?: string };
};

type ExternalTaskRun = {
  id: string;
  task_id: string;
  task_path: string;
  status: string;
  started_at: string | null;
  trace_token: string;
};

type ExternalBatchDetail = {
  id: string;
  project: string;
  status: string;
  task_runs: ExternalTaskRun[];
};

type TaskRunTrigger = {
  source: string | null;
  actor: string | null;
  hostname: string | null;
  user_agent: string | null;
  entrypoint: string | null;
  initiated_at: string | null;
  ci_system: string | null;
  ci_run_id: string | null;
  ci_run_url: string | null;
  repository: string | null;
  branch: string | null;
  commit_sha: string | null;
  pr_number: string | null;
};

type BatchDetail = {
  id: string;
  status: string;
  task_runs: TaskRunSummary[];
};

type TaskRunSummary = {
  id: string;
  batch_run_id: string;
  task_id: string;
  task_path: string;
  adapter_name: string | null;
  status: string;
  pass_result: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  trace_run_id: string | null;
  error_message: string | null;
  total_cost: number | null;
  trigger: TaskRunTrigger | null;
  run_configuration?: { model: string; effort?: string } | null;
};

type TaskRunDetail = TaskRunSummary & {
  total_tokens?: number | null;
  checks_json: CheckResult[] | null;
  transcript_json: Record<string, unknown> | null;
  deliverables_json: Record<string, unknown> | null;
};

const TASK_RUN_POLL_INTERVAL_MS = 1_000;
const TASK_RUN_MAX_WAIT_MS = 150_000;

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskRef = requirePositional(positional, 0, "task-id | path");

  const flagLocal = getBoolFlag(flags, "local");
  const flagRemote = getBoolFlag(flags, "remote");
  const executorFlag = typeof flags["executor"] === "string" ? flags["executor"] : undefined;
  const noRecord = getBoolFlag(flags, "no-record");

  // Resolve the task's filesystem path + its declared execution preference.
  // We read `execution` statically (no module load) so we don't re-register
  // checks just to pick a dispatch mode.
  const resolved = resolveTask(taskRef, config.taskRoot);
  if (!resolved) {
    console.error(`Task not found: ${taskRef}`);
    return 2;
  }

  // caller execution is the only recorded runtime. --no-record
  // forces an unrecorded local run. --executor caller is accepted as a no-op
  // for one release of backward compatibility.
  if (noRecord) {
    return runLocally(config, resolved.taskDir);
  }

  // Default recorded path: caller create-and-claim.
  if (config.projectId && config.apiKey) {
    if (await isBackendReachable(config.backendUrl)) {
      return runCallerRecorded(config, resolved);
    }
    console.error(`${red("error:")} backend unreachable; configured recording failed (use --no-record to run unrecorded)`);
    return 2;
  }

  // No project or credential configured → run unrecorded with a notice.
  console.error(`${dim("note:")} run is not being recorded (no project or credential configured)`);
  return runLocally(config, resolved.taskDir);
}

/**
 * Dispatch to the Issue #4 local-recorded path, applying the reachability
 * fallback it has always had: if the backend isn't reachable (or no project
 * is set), degrade to an unrecorded local run with a warning. The implicit
 * task/project paths inherit the exact same fallback.
 */
type ResolvedTask = {
  taskId: string | undefined;
  taskDir: string;
};

function resolveTask(ref: string, taskRoot: string): ResolvedTask | null {
  const asPath = resolve(ref);
  if (existsSync(asPath)) {
    const meta = discoverTaskMeta(taskRoot).find(
      (t) => resolve(t.path) === asPath,
    );
    return {
      taskDir: asPath,
      taskId: meta?.id,
    };
  }

  const match = findTaskMetaById(taskRoot, ref);
  if (!match) return null;
  return {
    taskDir: match.path,
    taskId: match.id,
  };
}

function resolveCiTrigger(flags: Record<string, string | boolean>): Record<string, unknown> | null {
  const ciFlag = flags.ci === true || process.env.CI === "true";
  if (!ciFlag) return null;

  return {
    source: "ci",
    actor: resolveFlagOrEnv(flags, "ci-actor", "APO_CI_ACTOR") ?? "ci",
    hostname: resolveFlagOrEnv(flags, "ci-hostname", "APO_CI_HOSTNAME") ?? null,
    entrypoint: "apo task run --ci",
    initiated_at: new Date().toISOString(),
    ci_system: resolveFlagOrEnv(flags, "ci-system", "APO_CI_SYSTEM") ?? detectCiSystem(),
    ci_run_id: resolveFlagOrEnv(flags, "ci-run-id", "APO_CI_RUN_ID") ?? process.env.GITHUB_RUN_ID ?? null,
    ci_run_url: resolveFlagOrEnv(flags, "ci-run-url", "APO_CI_RUN_URL") ?? null,
    repository: resolveFlagOrEnv(flags, "repo", "APO_GITHUB_REPO") ?? process.env.GITHUB_REPOSITORY ?? null,
    branch: resolveFlagOrEnv(flags, "branch", "APO_GITHUB_BRANCH") ?? process.env.GITHUB_HEAD_REF ?? process.env.GITHUB_REF_NAME ?? null,
    commit_sha: resolveFlagOrEnv(flags, "sha", "APO_GITHUB_SHA") ?? process.env.GITHUB_SHA ?? null,
    pr_number: resolveFlagOrEnv(flags, "pr", "APO_GITHUB_PR") ?? process.env.GITHUB_EVENT_NUMBER ?? null,
  };
}

function detectCiSystem(): string | null {
  if (process.env.GITHUB_ACTIONS === "true") return "github-actions";
  if (process.env.GITLAB_CI === "true") return "gitlab-ci";
  if (process.env.CIRCLECI === "true") return "circleci";
  if (process.env.JENKINS_URL) return "jenkins";
  return null;
}

function resolveFlagOrEnv(
  flags: Record<string, string | boolean>,
  flagName: string,
  envVar: string,
): string | null {
  const flagVal = flags[flagName];
  if (typeof flagVal === "string" && flagVal) return flagVal;
  return process.env[envVar] ?? null;
}

async function runLocally(config: Config, taskDir: string): Promise<number> {
  loadEnvFiles(taskDir);
  const { runTaskDir } = await import("@apo-ai/sdk/agent-task");

  let summary: LocalRunSummary;
  try {
    console.log(dim(`Running task from ${taskDir}...`));
    summary = await runTaskDir(taskDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: ${message}`));
    return 2;
  }

  if (config.json) {
    console.log(formatJson(summary));
  } else {
    printLocalRunSummary(summary);
  }

  return summary.pass ? 0 : 1;
}

/**
 * recorded caller execution. Hashes the real caller workspace, creates
 * + claims one Attempt, /start, runs the SDK Task locally with the Attempt JWT
 * in the child env (never the Project API key), heartbeats, and submits the
 * result/failure through the scoped protocol.
 */
async function runCallerRecorded(config: Config, resolved: ResolvedTask): Promise<number> {
  const taskDir = resolved.taskDir;
  const taskId = resolved.taskId ?? taskDir;
  const backendUrl = config.backendUrl;

  // 1. Build the attestation over the actual caller bytes + Git provenance.
  const walked = walkWorkspaceForRevision({ rootDir: config.taskRoot });
  const git = readGitProvenance(config.taskRoot);
  const identity = buildCallerIdentity({ clientVersion: "0.1.0" });

  // SPEC-169: every recorded run carries its canonical local Task Definition.
  // Fail before creating the Run if source cannot be prepared: a source-less
  // recorded Run cannot render its Tests and violates the caller contract.
  let taskDefinition;
  try {
    const allMeta = discoverTaskMeta(config.taskRoot);
    const taskMeta = allMeta.find((m) => m.id === taskId) ?? allMeta.find((m) => m.path === taskDir);
    if (!taskMeta) {
      throw new Error(
        `Task '${taskId}' has no canonical *.eval.ts definition under ${config.taskRoot}`,
      );
    }
    taskDefinition = prepareTaskDefinition(taskMeta).document;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: could not prepare Task definition: ${message}`));
    return 2;
  }

  // 2. Create-and-claim.
  let created;
  try {
    created = await createCallerRun({
      backendUrl, apiKey: config.apiKey ?? "", project: config.projectId ?? "",
      task: {
        task_id: taskId, task_path: taskId, display_name: taskId,
        adapter_name: null, has_checks: false,
      },
      environment: "default", runMetadata: { trigger: { source: "cli", executor: "caller" } },
      attestation: {
        source_type: "caller_worktree",
        repository_url: git.repositoryUrl,
        base_commit_sha: git.baseCommitSha,
        dirty: git.dirty,
        content_sha256: walked.contentSha256,
        task_root_label: config.taskRoot,
        file_count: walked.manifest.summary.fileCount,
        uncompressed_size_bytes: walked.manifest.summary.uncompressedSizeBytes,
      },
      identity,
      taskDefinition,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: caller create-and-claim failed: ${message}`));
    return 2;
  }

  console.log(dim(`Executor: caller (recorded in project ${config.projectId})`));
  console.log(dim(
    `Revision: ${git.dirty ? "dirty worktree" : "clean worktree"} ` +
    `${git.baseCommitSha ?? "(no commit)"}` +
    (git.repositoryUrl ? ` from ${git.repositoryUrl}` : ""),
  ));

  // 3. Thread only Task-scoped values to the child SDK (Attempt JWT, not API key).
  // Use the backend URL this CLI is configured with, not the one the server
  // reports. `created.traceEndpoint` comes from the server's own APO_BACKEND_URL,
  // which a server behind a reverse proxy cannot know — it defaults to
  // http://127.0.0.1:8000, so the child SDK posts its spans at the developer's
  // own machine and the trace silently arrives with only the runtime's spans in
  // it. We just completed authenticated requests against config.backendUrl, so it
  // is known-reachable; the sibling dispatch path below already uses it. A
  // deployment that wants telemetry on a different ingress configures it here,
  // client-side, rather than relying on the server to guess its own address.
  process.env.AGENT_TASK_TRACE_ENDPOINT = config.backendUrl.replace(/\/$/, "");
  // AGENT_TASK_PROJECT is the name the SDK reads (task-runtime.ts gates tracing on
  // endpoint && AGENT_TASK_PROJECT). This used to set AGENT_TASK_TRACE_PROJECT,
  // which nothing reads, so caller execution fell through to noop tracing: no
  // trace was recorded, and — because no OTel span was ever active — a runtime
  // that nests under a propagated traceparent opened its own unlinked root
  // instead. Silent, despite AGENT_TASK_TRACE_REQUIRED below.
  process.env.AGENT_TASK_PROJECT = created.traceProject;
  process.env.AGENT_TASK_RUN_ID = created.taskRunId;
  process.env.AGENT_TASK_TRACE_REQUIRED = "true";
  process.env.APO_AUTH_TOKEN = created.lease.token;

  // 4. Import the SDK BEFORE /start (issue #108). Startup failures (package
  // not found, module-resolution errors) must happen pre-start so the lease
  // reaper requeues the attempt instead of marking it LOST with the misleading
  // "after task code started" message. The trace env vars are already set
  // (step 3), and the SDK reads them at import time — no /start dependency.
  let runTaskDirImpl: (taskDir: string) => Promise<unknown>;
  let persistFileArtifactsImpl: typeof import("@apo-ai/sdk/agent-task").persistFileArtifacts | undefined;
  try {
    const mod = await import("@apo-ai/sdk/agent-task");
    runTaskDirImpl = mod.runTaskDir;
    persistFileArtifactsImpl = mod.persistFileArtifacts;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: failed to load task SDK: ${message}`));
    delete process.env.APO_AUTH_TOKEN;
    return 2;
  }

  // 5. /start (now after a successful SDK import — startup failures are pre-start).
  try {
    await startCallerAttempt(backendUrl, created.lease);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(red(`Error: /start failed: ${message}`));
    return 2;
  }

  // 6. Run the Task locally with a background heartbeat.
  const heartbeat = new CallerHeartbeat(backendUrl, created.lease, () => {
    console.error(red("Warning: lease reported stale/cancelled"));
  });
  heartbeat.start("running");
  loadEnvFiles(taskDir);

  const completionId = `${created.lease.attemptId}-${created.lease.generation}`;
  let exitCode = 0;
  let resultStarted = false;
  let artifactPhase = false;
  try {
    const summary = await runTaskDirImpl(taskDir) as LocalRunSummary;
    await heartbeat.stop();

    // SPEC-172: upload file artifacts after checks, before result submission.
    const rawDeliverables = (summary as { deliverables?: Record<string, unknown> }).deliverables ?? {};
    let jsonDeliverables: Record<string, unknown> = rawDeliverables;
    if (persistFileArtifactsImpl) {
      artifactPhase = true;
      const prepared = await persistFileArtifactsImpl(rawDeliverables, {
        taskRunId: created.taskRunId,
        authToken: created.lease.token,
        baseUrl: backendUrl,
        fetch,
      });
      artifactPhase = false;
      jsonDeliverables = prepared.jsonDeliverables;
    }

    resultStarted = true;
    await submitCallerResult(backendUrl, created.lease, {
      completion_id: completionId,
      pass_result: summary.pass,
      adapter_name: summary.adapterName ?? null,
      trace_run_id: summary.traceRunId ?? null,
      checks: summary.checks as unknown,
      transcript: (summary as { transcript?: Record<string, unknown> }).transcript ?? null,
      deliverables: jsonDeliverables,
      run_configuration: (summary as { runConfiguration?: { model: string; effort?: string } }).runConfiguration ?? null,
    });
    // render the result so the CLI shows PASS/FAIL + checks,
    // just like the local and backend paths it replaced.
    if (config.json) {
      console.log(JSON.stringify(summary));
    } else {
      printLocalRunSummary(summary);
    }
    exitCode = summary.pass ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await heartbeat.stop();
    if (resultStarted) {
      // SPEC-172: ambiguous result — the server may have committed before the
      // connection failed. Do NOT send a contradictory failure.
      console.error(red(`Error: result submission outcome unknown: ${message}`));
      exitCode = 2;
    } else {
      try {
        await submitCallerFailure(backendUrl, created.lease, {
          completion_id: completionId,
          failure_kind: artifactPhase ? "driver" : "task_process",
          error_message: message,
        });
      } catch (reportError) {
        const reportMessage = reportError instanceof Error ? reportError.message : String(reportError);
        console.error(red(`Warning: failed to report failure to backend: ${reportMessage}`));
      }
      console.error(red(`Error: ${message}`));
      exitCode = 2;
    }
  } finally {
    delete process.env.APO_AUTH_TOKEN;
  }
  return exitCode;
}

function isTerminalStatus(status: string): boolean {
  return status === "passed" || status === "failed" || status === "error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function printLocalRunSummary(summary: LocalRunSummary): void {
  console.log("");
  console.log(`${passFail(summary.pass)} ${bold(summary.taskId)}`);

  if (summary.checks.length > 0) {
    console.log(bold("  Checks:"));
    console.log(formatChecks(summary.checks));
  } else if (!summary.pass) {
    // Issue #8: a failed run with zero checks is almost always a silent
    // registration bug (e.g. a double-import that wiped the check registry).
    // Don't leave the user staring at a bare FAIL — say what went wrong.
    console.log(`  ${NO_CHECKS_REGISTERED_MESSAGE}`);
  }
}

function printTaskRunDetail(run: TaskRunDetail): void {
  console.log(bold(`Run: ${run.id}`));
  console.log(`  Task:      ${run.task_id}`);
  if (run.batch_run_id) {
    console.log(`  Batch:     ${run.batch_run_id} ${dim("(apo batch show " + run.batch_run_id + ")")}`);
  }
  console.log(`  Adapter:   ${run.adapter_name ?? "-"}`);
  console.log(`  Status:    ${run.status}`);
  console.log(
    `  Result:    ${run.pass_result === null ? "-" : passFail(run.pass_result)}`,
  );
  console.log(`  Started:   ${run.started_at ? formatTime(run.started_at) : "-"}`);
  if (run.completed_at) {
    console.log(`  Completed: ${formatTime(run.completed_at)}`);
  }
  if (run.total_cost !== null) {
    console.log(`  Cost:      $${run.total_cost.toFixed(6)}`);
  }
  if (run.total_tokens != null) {
    console.log(`  Tokens:    ${run.total_tokens.toLocaleString()}`);
  }
  console.log(`  Source:    ${formatTriggerOpt(run.trigger)}`);
  if (run.trace_run_id) {
    console.log(`  Trace:     ${run.trace_run_id}`);
  }
  if (run.error_message) {
    console.log(`  Error:     ${run.error_message}`);
  }

  if (run.checks_json?.length) {
    console.log(bold("  Checks:"));
    console.log(formatChecks(run.checks_json));
  } else if (run.pass_result === false) {
    console.log(`  ${NO_CHECKS_REGISTERED_MESSAGE}`);
  }
}

function formatTriggerOpt(trigger: TaskRunTrigger | null): string {
  if (!trigger) {
    return "-";
  }

  return formatTrigger({
    source: trigger.source,
    actor: trigger.actor,
    hostname: trigger.hostname,
    entrypoint: trigger.entrypoint,
    repository: trigger.repository,
    branch: trigger.branch,
    commit_sha: trigger.commit_sha,
    pr_number: trigger.pr_number,
  });
}

function loadEnvFiles(taskDir: string): void {
  const candidates = [
    resolve(taskDir, ".env"),
    resolve(taskDir, "../../.env"),
    resolve(process.cwd(), "backend/.env"),
    resolve(process.cwd(), "apps/example-service/.env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && !(key in process.env)) {
          process.env[key] = val;
        }
      }
    } catch {
      // skip unreadable
    }
  }
}
