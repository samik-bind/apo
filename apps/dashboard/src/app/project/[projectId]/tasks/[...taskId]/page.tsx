import {
  getProjectAgentTask,
  listTaskRuns,
} from "@/lib/agent-task-api";
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

  try {
    const [resolved, runs] = await Promise.all([
      getProjectAgentTask(projectId, taskId),
      listTaskRuns(taskId, projectId, cohort),
    ]);
    task = resolved;
    taskRuns = runs;
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
          <TaskRunHistory runs={taskRuns} />
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
