import { notFound } from "next/navigation";

import {
  listProjectAgentTasks,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import {
  getTaskViewComparisonOverview,
} from "@/lib/agent-task-view-api";
import { CompareViewsClient } from "./compare-views-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Compare views" };

export default async function CompareViewsPage({
  params,
}: {
  params: Promise<{ projectId: string; comparisonId: string }>;
}) {
  const { projectId, comparisonId } = await params;

  // SPEC-177: fetch only the lightweight overview (snapshot + scalar
  // summaries). Check Reports, Task Definition bodies, transcripts, and
  // Deliverable JSON are loaded progressively when a task is expanded.
  const [overview, inventory] = await Promise.all([
    getTaskViewComparisonOverview(projectId, comparisonId).catch(() => notFound()),
    listProjectAgentTasks(projectId).catch(() => [] as AgentTaskSummary[]),
  ]);
  const { snapshot } = overview;
  const runMap = new Map(overview.runs.map((run) => [run.id, run]));
  const leftRuns = snapshot.resolved
    .map((cell) => (cell.a_run_id ? runMap.get(cell.a_run_id) : undefined))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const rightRuns = snapshot.resolved
    .map((cell) => (cell.b_run_id ? runMap.get(cell.b_run_id) : undefined))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const comparisonStates = new Map(
    snapshot.resolved.map((cell) => [cell.task_id, cell.state] as const),
  );

  return (
    <CompareViewsClient
      projectId={projectId}
      comparisonId={comparisonId}
      snapshot={snapshot}
      tasks={inventory}
      leftRuns={leftRuns}
      rightRuns={rightRuns}
      stateByTask={comparisonStates}
    />
  );
}
