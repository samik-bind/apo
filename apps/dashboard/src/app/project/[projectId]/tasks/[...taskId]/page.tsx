import {
  getProjectAgentTask,
  listTaskRuns,
} from "@/lib/agent-task-api";
import { getProject } from "@/lib/projects-api";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TaskFileBrowser } from "@/components/agent-task-files/task-file-browser";
import { TaskRunHistory } from "./task-run-history";
import Link from "next/link";
import type { Metadata } from "next";
import { FolderOpen } from "lucide-react";
import { sinceLabel } from "@/lib/since-window";
import { taskDetailHref } from "@/lib/task-routes";

export const dynamic = "force-dynamic";

// The route is a catch-all (`tasks/[...taskId]`) because task ids are
// hierarchical paths with slashes (e.g. "openai-agent/data-extraction").
// Join the captured segments back into the slash-delimited id the API expects.
const joinTaskId = (segments: string[]): string => segments.join("/");

// The run-history cohort, carried from the Tasks page's active evidence view
// (`?model=&effort=&since=`, the same vocabulary the Runs page reads). Absent
// params mean all-history. See `lib/run-cohort`.
interface CohortSearchParams {
  model?: string;
  effort?: string;
  since?: string;
}

function parseCohort(
  query: Record<string, string | string[] | undefined>,
): CohortSearchParams {
  const first = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === "string" && value ? value : undefined;
  };
  return { model: first("model"), effort: first("effort"), since: first("since") };
}

// Tab title: "Task: <display_name>". Falls back to "Task" on any failure.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string[] }>;
}): Promise<Metadata> {
  const { projectId, taskId: taskIdSegments } = await params;
  const taskId = joinTaskId(taskIdSegments);
  try {
    const task = await getProjectAgentTask(projectId, taskId);
    return { title: `Task: ${task.display_name}` };
  } catch {
    return { title: "Task" };
  }
}

const EMPTY_TASK_RUNS: Awaited<ReturnType<typeof listTaskRuns>> = [];

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string; taskId: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ projectId, taskId: taskIdSegments }, query] = await Promise.all([
    params,
    searchParams,
  ]);
  const taskId = joinTaskId(taskIdSegments);
  const cohort = parseCohort(query);
  const cohortActive = cohort.model !== undefined || cohort.effort !== undefined || cohort.since !== undefined;

  let task: Awaited<ReturnType<typeof getProjectAgentTask>> | null = null;
  let taskRuns = EMPTY_TASK_RUNS;
  let error: string | null = null;
  let canDeleteRuns = false;

  try {
    // The project read feeds the run-delete role gate (best-effort — a
    // failure degrades to no delete button, not a broken page).
    const [resolved, runs, project] = await Promise.all([
      getProjectAgentTask(projectId, taskId),
      listTaskRuns(taskId, projectId, cohort),
      getProject(projectId).catch(() => null),
    ]);
    task = resolved;
    taskRuns = runs;
    canDeleteRuns =
      project?.current_user_role === "owner" ||
      project?.current_user_role === "admin";
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch task details";
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-6xl flex flex-col">
        <div className="border-b border-border px-6 py-5">
          <Link
            href={`/project/${projectId}/tasks`}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            &larr; Tasks
          </Link>
        </div>
        <div className="mx-6 mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          {error}
        </div>
      </div>
    );
  }

  if (!task) return null;

  const fileCount = (task.has_checks ? 1 : 0) + 1;

  return (
    <div className="mx-auto w-full max-w-6xl flex flex-col">
      {/* Page header */}
      <div className="border-b border-border px-6 py-5">
        <Link
          href={`/project/${projectId}/tasks`}
          className="text-[12px] text-muted-foreground hover:text-foreground"
        >
          &larr; Tasks
        </Link>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-3">
          <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
          <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-tight">{task.display_name}</h1>
          <Badge variant="outline" className="text-[10px]">{task.adapter_name}</Badge>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline" className="font-mono text-[10px]">{task.folder_path || "(root)"}</Badge>
          <Badge variant="outline" className="text-[10px]">{fileCount} files</Badge>
          <Badge variant="outline" className="text-[10px]">
            {taskRuns.length} task runs{cohortActive ? " in view" : ""}
          </Badge>
        </div>
        {cohortActive && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>Run history scoped to:</span>
            {cohort.model && (
              <Badge variant="outline" className="font-mono text-[10px]">{cohort.model}</Badge>
            )}
            {cohort.effort && (
              <Badge variant="outline" className="text-[10px]">effort: {cohort.effort}</Badge>
            )}
            {cohort.since && (
              <Badge variant="outline" className="text-[10px]">last {sinceLabel(cohort.since)}</Badge>
            )}
            <Link
              href={taskDetailHref(projectId, taskId)}
              className="ml-1 underline underline-offset-4 hover:text-foreground"
            >
              All history
            </Link>
          </div>
        )}

      </div>

      <Tabs defaultValue="runs" className="flex flex-col">
        <div className="border-b border-border px-6">
          <TabsList className="h-10 bg-card">
            <TabsTrigger value="runs" className="px-4 text-[13px]">Task Run History</TabsTrigger>
            <TabsTrigger value="files" className="px-4 text-[13px]">
              Files
              <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0">
                {fileCount}
              </Badge>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="runs" className="mt-0">
          <TaskRunHistory runs={taskRuns} canDelete={canDeleteRuns} />
        </TabsContent>

        <TabsContent value="files" className="mt-0 p-6">
          <TaskFileBrowser
            taskId={taskId}
            projectId={projectId}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
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
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
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
    />
  );
}
