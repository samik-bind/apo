import { listProjectAgentTasks } from "@/lib/agent-task-api";
import { getProject } from "@/lib/projects-api";
import { getProjectOnboardingStatus } from "@/lib/projects-api";
import {
  buildCliLoginCommand,
  EXAMPLE_URL,
  HOSTED_DOCS_URL,
  isValidPublicOrigin,
  type ProjectFirstRunSetup,
} from "@/lib/first-run";
import { DEMO_PROJECT } from "@/lib/project-router";
import { AgentTasksClient } from "./tasks-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Tasks" };

export default async function AgentTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId }, query] = await Promise.all([params, searchParams]);
  // SPEC-187: arriving via <- Tasks with ?view= re-selects that saved tab.
  const viewRaw = query.view;
  const viewSingle = Array.isArray(viewRaw) ? viewRaw[0] : viewRaw;
  const initialViewId =
    typeof viewSingle === "string" && viewSingle ? viewSingle : null;
  const isDemo = projectId === DEMO_PROJECT;

  let tasks: Awaited<ReturnType<typeof listProjectAgentTasks>> = [];
  let error: string | null = null;
  let taskSource = null;
  // SPEC-180: first-run panel inputs — parallel-safe, best-effort. A
  // missing status never breaks the page; it only suppresses onboarding.
  let onboarding: Awaited<ReturnType<typeof getProjectOnboardingStatus>> | null =
    null;

  const [projectResult, statusResult] = await Promise.allSettled([
    getProject(projectId),
    isDemo ? Promise.resolve(null) : getProjectOnboardingStatus(projectId),
  ]);
  if (projectResult.status === "fulfilled") {
    taskSource = projectResult.value.task_source;
  } else {
    error =
      projectResult.reason instanceof Error
        ? projectResult.reason.message
        : "Failed to load project";
  }
  if (statusResult.status === "fulfilled") {
    onboarding = statusResult.value;
  }

  // Every project — demo included — resolves tasks through its
  // configured source inventory. Demo is provisioned with a bundled
  // `demo` source at startup, so it needs no special case.
  if (taskSource !== null && !taskSource.inventory_stale) {
    try {
      tasks = await listProjectAgentTasks(projectId);
    } catch (e: unknown) {
      error = e instanceof Error ? e.message : "Failed to fetch agent tasks";
    }
  }

  // The full first-run journey shows only for a genuinely virgin,
  // non-demo Project: nothing published, nothing recorded, no load error.
  // `welcome=1` may highlight it but durable emptiness is the real gate.
  let firstRunSetup: ProjectFirstRunSetup | null = null;
  if (
    !isDemo &&
    !error &&
    onboarding !== null &&
    onboarding.published_task_count === 0 &&
    onboarding.recorded_run_count === 0
  ) {
    const publicUrl = isValidPublicOrigin(onboarding.public_url)
      ? onboarding.public_url
      : "";
    firstRunSetup = {
      publicUrl,
      projectId,
      cliLoginCommand: publicUrl ? buildCliLoginCommand(publicUrl, projectId) : "",
      docsUrl: HOSTED_DOCS_URL,
      exampleUrl: EXAMPLE_URL,
    };
  }

  return (
    <AgentTasksClient
      tasks={tasks}
      error={error}
      taskSource={taskSource}
      isDemo={isDemo}
      firstRunSetup={firstRunSetup}
      initialViewId={initialViewId}
    />
  );
}
