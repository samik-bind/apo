import {
  listAgentTaskSchedules,
  listProjectAgentTasks,
} from "@/lib/agent-task-api";
import { getProject, type ProjectTaskSource } from "@/lib/projects-api";
import { listExecutorPools } from "@/lib/executor-api";
import { AgentTaskSchedulesClient } from "./schedules-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Schedules" };

const EMPTY_TASKS: Awaited<ReturnType<typeof listProjectAgentTasks>> = [];
const EMPTY_SCHEDULES: Awaited<ReturnType<typeof listAgentTaskSchedules>> = [];
const EMPTY_EXECUTOR_POOLS: Awaited<ReturnType<typeof listExecutorPools>> = [];

export default async function AgentTaskSchedulesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ taskIds?: string }>;
}) {
  const [{ projectId }, { taskIds }] = await Promise.all([params, searchParams]);

  let tasks = EMPTY_TASKS;
  let schedules = EMPTY_SCHEDULES;
  let error: string | null = null;
  let taskSource: ProjectTaskSource | null = null;
  let executorPools: Awaited<ReturnType<typeof listExecutorPools>> = EMPTY_EXECUTOR_POOLS;

  let canManage = true;
  try {
    [schedules, taskSource, executorPools, canManage] = await Promise.all([
      listAgentTaskSchedules(projectId),
      getProject(projectId)
        .then((project) => {
          // Schedule management is admin-tier; viewers (and the anonymous
          // demo visitor) never see the controls at all (SPEC-188 U3).
          canManage = project.permissions?.can_manage_project === true;
          return project.task_source;
        })
        .catch(() => null),
      listExecutorPools(projectId),
      Promise.resolve(true),
    ]);

    // The task list always comes from the project's configured source
    // inventory — demo included (it is provisioned with a bundled `demo`
    // source at startup). Projects without a source render the
    // ProjectTaskSourceEmptyState in the schedules client.
    if (taskSource && !taskSource.inventory_stale) {
      tasks = await listProjectAgentTasks(projectId);
    }
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to load schedules";
  }

  const initialTaskIds = taskIds
    ? taskIds
        .split(",")
        .flatMap((value) => { const trimmed = value.trim(); return trimmed ? [trimmed] : []; })
    : [];

  return (
    <AgentTaskSchedulesClient
      tasks={tasks}
      schedules={schedules}
      initialTaskIds={initialTaskIds}
      error={error}
      taskSource={taskSource}
      executorPools={executorPools}
      canManage={canManage}
    />
  );
}
