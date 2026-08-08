import { notFound } from "next/navigation";

import {
  getAgentTaskRun,
  listProjectAgentTasks,
  type AgentTaskRunSummary,
  type AgentTaskSummary,
} from "@/lib/agent-task-api";
import {
  getTaskViewComparison,
  type TaskViewComparisonSnapshot,
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

  let snapshot: TaskViewComparisonSnapshot | null = null;
  try {
    snapshot = await getTaskViewComparison(projectId, comparisonId);
  } catch {
    notFound();
  }
  if (!snapshot) notFound();

  const inventory: AgentTaskSummary[] = await listProjectAgentTasks(projectId).catch(() => []);

  // Fetch the full run details for every resolved run_id in the snapshot so the
  // comparison page can show checks, costs, traces — the same richness as
  // /runs/compare. Null run_ids (Not Run on that side) are skipped.
  const runIds = snapshot.resolved
    .flatMap((cell) => [cell.a_run_id, cell.b_run_id])
    .filter((id): id is string => id !== null);
  const runs = await Promise.all(
    runIds.map((id) => getAgentTaskRun(id).catch(() => null)),
  );
  const runMap = new Map<string, AgentTaskRunSummary>();
  for (const run of runs) {
    if (run) runMap.set(run.id, run);
  }
  const leftRuns = snapshot.resolved
    .map((cell) => (cell.a_run_id ? runMap.get(cell.a_run_id) : undefined))
    .filter((r): r is AgentTaskRunSummary => r !== undefined);
  const rightRuns = snapshot.resolved
    .map((cell) => (cell.b_run_id ? runMap.get(cell.b_run_id) : undefined))
    .filter((r): r is AgentTaskRunSummary => r !== undefined);

  return (
    <CompareViewsClient
      projectId={projectId}
      snapshot={snapshot}
      tasks={inventory}
      leftRuns={leftRuns}
      rightRuns={rightRuns}
    />
  );
}
