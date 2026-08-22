import { existsSync } from "fs";
import { parseArgs, getBoolFlag } from "../lib/args.ts";
import { apiGet, isBackendReachable } from "../lib/api.ts";
import type { AgentTaskSummary } from "../lib/agent-task-types.ts";
import { resolveConfig } from "../lib/config.ts";
import { dim, formatJson, formatTable } from "../lib/format.ts";
import { discoverTaskMeta, type TaskMeta } from "../lib/task-meta.ts";

/**
 * One universe: the task root your login captured is what `task list`,
 * `task show`, and `task run` all resolve against — anything listed is
 * runnable. The backend's published inventory is the explicit `--catalog`
 * view (or the fallback when no local task root exists).
 */
export async function run(argv: string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  const explicitDir =
    typeof config._rawFlags["dir"] === "string" || !!process.env.APO_TASK_ROOT;
  const catalogFlag = getBoolFlag(flags, "catalog");
  const rootExists = existsSync(config.taskRoot);

  let useCatalog: boolean;
  if (catalogFlag) {
    if (!config.projectId) {
      console.error("--catalog requires a project (run: apo project use).");
      return 2;
    }
    useCatalog = true;
  } else if (explicitDir) {
    useCatalog = false;
  } else if (rootExists) {
    useCatalog = false;
  } else if (config.projectId && await isBackendReachable(config.backendUrl)) {
    useCatalog = true;
  } else {
    useCatalog = false;
  }

  if (!useCatalog && !rootExists) {
    console.error(`Task root not found: ${config.taskRoot}`);
    console.error("Set --dir <path> or APO_TASK_ROOT, or re-run `apo login` from your task repository.");
    return 2;
  }

  let tasks: TaskMeta[] | AgentTaskSummary[];
  if (useCatalog) {
    tasks = await apiGet<AgentTaskSummary[]>(
      config.backendUrl,
      `/v1/projects/${encodeURIComponent(config.projectId!)}/agent-tasks`,
      undefined,
      config,
    );
  } else {
    tasks = discoverTaskMeta(config.taskRoot);
  }

  const source = useCatalog
    ? `backend catalog (project ${config.projectId})`
    : `scanned ${config.taskRoot}`;

  if (config.json) {
    console.log(
      formatJson({
        source: useCatalog ? "backend" : "local",
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
  let footer = `${tasks.length} task${tasks.length === 1 ? "" : "s"} found — ${source}`;
  if (useCatalog && !rootExists && !catalogFlag) {
    footer += dim(` (no local task root; run apo login --dir <path> to set one)`);
  }
  console.log(dim(footer));

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
