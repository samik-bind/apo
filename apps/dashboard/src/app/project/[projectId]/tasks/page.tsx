import {
  listAgentTasks,
  listProjectAgentTasks,
} from "@/lib/agent-task-api";
import { getProject } from "@/lib/projects-api";
import {
  getConnectedEnvironmentStatus,
  type ConnectedEnvironmentState,
} from "@/lib/executor-api";
import { DEMO_PROJECT } from "@/lib/project-router";
import { AgentTasksClient } from "./tasks-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tasks" };

const TASK_ROOT = process.env.NEXT_PUBLIC_AGENT_TASK_ROOT ?? null;

export default async function AgentTasksPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const isDemo = projectId === DEMO_PROJECT;

  let tasks: Awaited<ReturnType<typeof listAgentTasks>> = [];
  let error: string | null = null;
  let taskSource = null;
  // the aggregate Connected Environment state replaces Pool
  // selection for the native Run path. A status-fetch failure is non-blocking
  // — the run can still be queued.
  let connectedState: ConnectedEnvironmentState | null = null;
  let connectedStateError: string | null = null;

  try {
    // Fetch the project so we can branch on task source presence.
    try {
      const project = await getProject(projectId);
      taskSource = project.task_source;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Failed to load project";
    }

    // non-demo projects must NOT inherit example-service tasks
    // via the legacy DEFAULT_TASK_ROOT fallback. The task list comes from
    // either the project's configured source or is
    // empty — which surfaces the setup card on the client.
    if (!isDemo && taskSource !== null && !taskSource.inventory_stale) {
      try {
        tasks = await listProjectAgentTasks(projectId);
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : "Failed to fetch agent tasks";
      }
    } else if (isDemo) {
      tasks = await listAgentTasks(TASK_ROOT, undefined, projectId);
    }

    if (!isDemo) {
      try {
        const status = await getConnectedEnvironmentStatus(projectId);
        connectedState = status.state;
      } catch (e: unknown) {
        connectedStateError =
          e instanceof Error ? e.message : "Failed to load connected environment status";
      }
    }
    // else: non-demo + no source → leave tasks empty so the setup card
    // renders instead of leaking example-service tasks.
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch agent tasks";
  }

  return (
    <AgentTasksClient
      tasks={tasks}
      error={error}
      taskSource={taskSource}
      isDemo={isDemo}
      connectedState={connectedState}
      connectedStateError={connectedStateError}
    />
  );
}
