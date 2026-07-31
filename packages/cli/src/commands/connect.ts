/**
 * SPEC-161: apo connect — foreground Connected Executor.
 *
 * Discovers local tasks, connects to the Apo server as a persistent
 * source-owned executor, and executes assigned tasks locally.
 */

import { green, red, dim, cyan } from "../lib/format.ts";
import { parseArgs, getFlagValue, getBoolFlag } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { discoverTaskMeta } from "../lib/task-meta.ts";
import { toPublishedTask } from "../lib/task-catalog.ts";
import { computeCatalogDigest } from "../lib/task-catalog-digest.ts";
import { loadExecutorState, saveExecutorState } from "../lib/executor-state.ts";
import {
  bootstrapAndEnroll,
  heartbeat,
  claimWork,
  submitAttestation,
  startAttempt,
  heartbeatAttempt,
  submitResult,
} from "../lib/connected-executor.ts";
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const dirFlag = getFlagValue(flags, "dir");
  const taskRoot = dirFlag ?? config.taskRoot ?? ".";
  const nameFlag = getFlagValue(flags, "name");
  const concurrency = parseInt(getFlagValue(flags, "concurrency") ?? "4", 10);
  const projectId = getFlagValue(flags, "project") ?? config.projectId;

  if (!projectId) {
    console.error(red("error: no project configured. Run `apo project use` first."));
    return 2;
  }
  if (!config.apiKey) {
    console.error(red("error: not logged in. Run `apo login` first."));
    return 2;
  }
  if (concurrency < 1 || !Number.isSafeInteger(concurrency)) {
    console.error(red("error: --concurrency must be a positive integer"));
    return 2;
  }

  // 1. Discover local tasks and compute digest
  const tasks = discoverTaskMeta(taskRoot);
  const published = tasks.map(toPublishedTask).sort((a, b) => a.task_id.localeCompare(b.task_id));
  const catalogDigest = computeCatalogDigest(published);
  console.log(dim(`Discovered ${published.length} task${published.length === 1 ? "" : "s"} in ${taskRoot}`));

  // 2. Load or create executor state
  let state = loadExecutorState(config.backendUrl, projectId, taskRoot);
  if (state === null) {
    console.log(dim("First connection — enrolling..."));
    try {
      state = await bootstrapAndEnroll({
        backendUrl: config.backendUrl,
        projectId,
        userAuthToken: config.apiKey!,
        name: nameFlag ?? `connected-${Date.now().toString(36)}`,
        taskRoot,
        concurrency,
      });
      saveExecutorState(state, { taskRoot });
      console.log(green(`✓ Enrolled as ${state.executor_name}`));
    } catch (err) {
      console.error(red(`error: enrollment failed: ${(err as Error).message}`));
      return 2;
    }
  } else {
    console.log(dim(`Reusing executor: ${state.executor_name}`));
  }

  // 3. Initial heartbeat + catalog check
  let eligibility = await safeHeartbeat(config.backendUrl, state.credential, catalogDigest, concurrency);
  if (eligibility === null) return 2;

  printEligibility(eligibility, projectId, concurrency);

  // 4. Main loop
  let running = 0;
  let shouldStop = false;

  const handleSignal = () => {
    if (!shouldStop) {
      shouldStop = true;
      console.log(dim("\nStopping — no new claims. Active tasks will finish. Press Ctrl+C again to force."));
    } else {
      console.error(red("Forcing exit."));
      process.exit(1);
    }
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  while (!shouldStop) {
    // Heartbeat periodically
    eligibility = await safeHeartbeat(config.backendUrl, state.credential, catalogDigest, concurrency);
    if (eligibility === null) {
      await sleep(5000);
      continue;
    }

    if (eligibility.status !== "ready") {
      printEligibility(eligibility, projectId, concurrency);
      await sleep(10_000);
      continue;
    }

    // Claim work if we have capacity
    const availableSlots = concurrency - running;
    if (availableSlots <= 0) {
      await sleep(2000);
      continue;
    }

    let assignment: Awaited<ReturnType<typeof claimWork>> = null;
    try {
      assignment = await claimWork({
        backendUrl: config.backendUrl,
        credential: state.credential,
        catalogDigest,
        availableSlots,
      });
    } catch (err) {
      if ((err as Error).message.includes("invalid or revoked")) {
        console.error(red("error: executor credential revoked. Re-run `apo connect` to re-enroll."));
        return 2;
      }
      console.error(dim(`claim error: ${(err as Error).message}`));
      await sleep(5000);
      continue;
    }

    if (assignment === null) {
      await sleep(5000);
      continue;
    }

    running++;
    console.log(cyan(`\n← Assigned: ${assignment.task_id}`));

    // Execute asynchronously
    executeAssignment(config.backendUrl, taskRoot, assignment)
      .catch((err) => console.error(red(`task ${assignment.task_id} failed: ${(err as Error).message}`)))
      .finally(() => {
        running--;
        console.log(dim(`✓ Completed: ${assignment.task_id} (${running} active)`));
      });

    await sleep(1000); // Small delay between claims
  }

  // Wait for running tasks
  console.log(dim("Waiting for active tasks to finish..."));
  while (running > 0) {
    await sleep(1000);
  }
  console.log(green("Disconnected."));
  return 0;
}

async function safeHeartbeat(
  backendUrl: string,
  credential: string,
  catalogDigest: string,
  slots: number,
) {
  try {
    return await heartbeat({ backendUrl, credential, catalogDigest, availableSlots: slots });
  } catch (err) {
    if ((err as Error).message.includes("invalid or revoked")) {
      console.error(red("error: executor credential revoked."));
      return null;
    }
    console.error(dim(`heartbeat error: ${(err as Error).message}`));
    return null;
  }
}

function printEligibility(
  eligibility: NonNullable<Awaited<ReturnType<typeof safeHeartbeat>>>,
  projectId: string,
  concurrency: number,
) {
  if (eligibility.status === "ready") {
    console.log(green(`Connected to ${projectId} · catalog matches · capacity ${concurrency}`));
    console.log(dim("Waiting for assignments…  Ctrl+C to stop"));
  } else if (eligibility.status === "catalog_mismatch") {
    console.log(dim(`Catalog mismatch — run \`apo task publish\` to update.`));
  } else {
    console.log(dim(`No catalog published — run \`apo task publish\` first.`));
  }
}

async function executeAssignment(
  backendUrl: string,
  taskRoot: string,
  assignment: Awaited<ReturnType<typeof claimWork>> & object,
): Promise<void> {
  // 1. Resolve task locally
  const tasks = discoverTaskMeta(taskRoot);
  const task = tasks.find((t) => t.id === assignment.task_id);
  if (!task) {
    throw new Error(`Task ${assignment.task_id} not found locally`);
  }

  // 2. Hash source (placeholder — real implementation uses walkWorkspaceForRevision)
  const contentSha256 = "0000000000000000000000000000000000000000000000000000000000000000";

  // 3. Submit attestation
  await submitAttestation({
    backendUrl,
    attemptJwt: assignment.attempt_jwt,
    attemptId: assignment.attempt_id,
    attestation: {
      source_type: "connected_worktree",
      repository_url: null,
      base_commit_sha: null,
      dirty: true,
      content_sha256: contentSha256,
      task_root_label: taskRoot.split("/").pop() || "tasks",
      file_count: 0,
      uncompressed_size_bytes: 0,
    },
  });

  // 4. Start
  await startAttempt({
    backendUrl,
    attemptJwt: assignment.attempt_jwt,
    attemptId: assignment.attempt_id,
  });

  // 5. Heartbeat while running
  const heartbeatInterval = setInterval(() => {
    heartbeatAttempt({
      backendUrl,
      attemptJwt: assignment.attempt_jwt,
      attemptId: assignment.attempt_id,
      phase: "running",
    }).catch(() => {});
  }, 30_000);

  try {
    // 6. Execute the task locally (simplified — real impl spawns a child)
    const { runTaskDir } = await import("@apo/sdk/agent-task");
    const summary = await runTaskDir(task.path) as { pass: boolean; adapterName?: string; checks?: unknown; traceRunId?: string };

    clearInterval(heartbeatInterval);

    // 7. Submit result
    await submitResult({
      backendUrl,
      attemptJwt: assignment.attempt_jwt,
      attemptId: assignment.attempt_id,
      result: {
        completion_id: `${assignment.attempt_id}-${Date.now()}`,
        pass_result: summary.pass,
        adapter_name: summary.adapterName ?? null,
        checks: summary.checks as unknown,
        trace_run_id: summary.traceRunId ?? null,
      },
    });
  } catch (err) {
    clearInterval(heartbeatInterval);
    // Submit failure
    await submitResult({
      backendUrl,
      attemptJwt: assignment.attempt_jwt,
      attemptId: assignment.attempt_id,
      result: {
        completion_id: `${assignment.attempt_id}-${Date.now()}`,
        pass_result: false,
        failure_kind: "task_runtime",
        error_message: (err as Error).message,
      },
    });
    throw err;
  }
}
