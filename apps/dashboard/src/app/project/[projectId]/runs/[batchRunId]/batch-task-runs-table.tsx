"use client";

import { useState } from "react";

import { ListPagination } from "@/components/table";
import { TaskRunListHeader, TaskRunRow } from "@/components/task-run-list";
import type { AgentTaskRunSummary } from "@/lib/agent-task-api";
import { Table, TableBody } from "@/components/ui/table";

const PAGE_SIZE = 20;

/** The batch run's task runs, in the shared task-run table with paging. */
export function BatchTaskRunsTable({
  runs,
  projectId,
}: {
  runs: AgentTaskRunSummary[];
  projectId: string;
}) {
  const [page, setPage] = useState(0);

  const totalPages = Math.ceil(runs.length / PAGE_SIZE);
  // A refresh can shrink the list — clamp into range.
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const visibleRuns = runs.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  return (
    <div className="flex flex-col">
      <Table density="compact" className="min-w-[560px]">
        <TaskRunListHeader />
        <TableBody>
          {visibleRuns.map((run) => (
            <TaskRunRow key={run.id} run={run} projectId={projectId} />
          ))}
        </TableBody>
      </Table>

      <ListPagination
        totalCount={runs.length}
        page={safePage}
        pageSize={PAGE_SIZE}
        totalPages={totalPages}
        itemName="task runs"
        onPageChange={setPage}
      />
    </div>
  );
}
