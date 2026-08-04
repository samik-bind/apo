import {
  listAgentTasks,
  listProjectAgentTasks,
} from "@/lib/agent-task-api";
import { getProject } from "@/lib/projects-api";
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

  try {
    try {
      const project = await getProject(projectId);
      taskSource = project.task_source;
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Failed to load project";
    }

    if (!isDemo && taskSource !== null && !taskSource.inventory_stale) {
      try {
        tasks = await listProjectAgentTasks(projectId);
      } catch (e: unknown) {
        error = e instanceof Error ? e.message : "Failed to fetch agent tasks";
      }
    } else if (isDemo) {
      tasks = await listAgentTasks(TASK_ROOT, undefined, projectId);
    }
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch agent tasks";
  }

  return (
    <AgentTasksClient
      tasks={tasks}
      error={error}
      taskSource={taskSource}
      isDemo={isDemo}
    />
  );
}
