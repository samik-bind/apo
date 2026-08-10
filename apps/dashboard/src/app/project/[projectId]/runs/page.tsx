import {
  listAgentTaskBatchRuns,
  type AgentTaskBatchRunSummary,
  type ModelFacetOption,
} from "@/lib/agent-task-api";
import { getProject, type ProjectTaskSource } from "@/lib/projects-api";
import { Suspense } from "react";
import { RunsClient } from "./runs-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Runs" };

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const query = await searchParams;

  const page = query.page ? Math.max(0, Number(query.page)) : 0;
  const pageSize = query.page_size ? Number(query.page_size) : 20;
  const q = typeof query.q === "string" ? query.q : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;
  const modelParam = typeof query.model === "string" ? query.model : undefined;
  const models = modelParam ? modelParam.split(",").filter(Boolean) : undefined;
  const effortParam = typeof query.effort === "string" ? query.effort : undefined;
  const efforts = effortParam ? effortParam.split(",").filter(Boolean) : undefined;

  let batchRuns: AgentTaskBatchRunSummary[] = [];
  let totalCount = 0;
  let totalPages = 0;
  let modelFacets: ModelFacetOption[] = [];
  let error: string | null = null;
  let taskSource: ProjectTaskSource | null = null;

  // Fetch runs list and project in parallel — they're independent.
  const projectPromise = getProject(projectId).catch(() => null);

  try {
    const paginated = await listAgentTaskBatchRuns(projectId, {
      q,
      status,
      model: models,
      effort: efforts,
      page,
      page_size: pageSize,
    });
    batchRuns = paginated.data;
    totalCount = paginated.total_count;
    totalPages = paginated.total_pages;
    modelFacets = paginated.model_facets;
  } catch (e: unknown) {
    error = e instanceof Error ? e.message : "Failed to fetch runs";
  }

  // Project result (started in parallel with the runs list).
  const project = await projectPromise;
  taskSource = project?.task_source ?? null;

  return (
    <main className="h-full flex flex-col">
      <Suspense>
        <RunsClient
          batchRuns={batchRuns}
          error={error}
          taskSource={taskSource}
          totalCount={totalCount}
          page={page}
          pageSize={pageSize}
          totalPages={totalPages}
          modelFacets={modelFacets}
        />
      </Suspense>
    </main>
  );
}
