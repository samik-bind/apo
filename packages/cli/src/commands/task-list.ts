import { existsSync } from "fs";
import { parseArgs } from "../lib/args.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import type { AgentTaskSummary } from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson, formatTable } from "../lib/format.ts";
import { discoverTaskMeta, type TaskMeta } from "../lib/task-meta.ts";

export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  // An explicit task root (--dir or APO_TASK_ROOT) means "scan here": it wins
  // over the backend catalog, matching how `apo task run --dir` resolves
  // tasks — locally, from that root.
  const explicitDir =
    typeof config._rawFlags["dir"] === "string" || !!process.env.APO_TASK_ROOT;
  const useBackend =
    !explicitDir && !!config.projectId && await isBackendReachable(config.backendUrl);

  if (!useBackend && !existsSync(config.taskRoot)) {
    console.error(`Task root not found: ${config.taskRoot}`);
    console.error("Set --dir <path> or APO_TASK_ROOT, or re-run `apo login` from your task repository.");
    return 2;
  }

  const tasks = useBackend
    ? await apiGet<AgentTaskSummary[]>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId!)}/agent-tasks`,
      undefined,
      config,
    )
    : discoverTaskMeta(config.taskRoot);

  const source = useBackend
    ? `backend catalog (project ${config.projectId})`
    : `scanned ${config.taskRoot}`;

  if (config.json) {
    console.log(
      formatJson({
        source: useBackend ? "backend" : "local",
        tasks: tasks.map(taskToJson),
      }),
    );
    return 0;
  }

  if (tasks.length === 0) {
    console.log(dim(`No tasks found — ${source}`));
    return 0;
  }

  const rows = tasks.map((t) => isRemoteTask(t)
    ? [
      t.id,
      t.adapter_name,
      t.has_checks ? "yes" : "-",
    ]
    : [
      t.id,
      t.adapter,
      t.hasChecks ? "yes" : "-",
    ]);
  console.log(
    formatTable(["ID", "Adapter", "Checks"], rows),
  );
  console.log("");
  console.log(dim(`${tasks.length} task${tasks.length === 1 ? "" : "s"} found — ${source}`));

  return 0;
}

function taskToJson(t: TaskMeta | AgentTaskSummary): Record<string, unknown> {
  if (isRemoteTask(t)) {
    return t;
  }

  return {
    id: t.id,
    adapter: t.adapter,
    hasChecks: t.hasChecks,
    path: t.path,
    deliverables: t.deliverables,
  };
}

function isRemoteTask(task: TaskMeta | AgentTaskSummary): task is AgentTaskSummary {
  return "adapter_name" in task;
}
