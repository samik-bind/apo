"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { History } from "lucide-react";
import {
  type AgentTaskBatchRunSummary,
  type ModelFacetOption,
} from "@/lib/agent-task-api";
import { type ProjectTaskSource } from "@/lib/projects-api";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { useProjectId } from "@/lib/project-router";
import { useClientNow } from "@/hooks/use-client-now";
import { RunsModelFilter, type ModelOption } from "./runs-model-filter";
import { RunsCompareBar } from "./components/RunsCompareBar";
import { ListPagination } from "@/components/table";
import { RunsRow } from "./components/RunsRow";
import { RunsToolbar } from "./components/RunsToolbar";
import { COL, computeOverlap } from "./components/runs-utils";
import { setModelArchived } from "@/lib/agent-task-view-api";
import { toast } from "sonner";

export function RunsClient({
  batchRuns,
  error: _error,
  taskSource,
  totalCount,
  page,
  pageSize,
  totalPages,
  modelFacets,
}: {
  batchRuns: AgentTaskBatchRunSummary[];
  error: string | null;
  taskSource: ProjectTaskSource | null;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  modelFacets: ModelFacetOption[];
}) {
  const projectId = useProjectId();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const clientNow = useClientNow();
  const sourceUnconfigured = taskSource === null && totalCount === 0;

  const updateUrl = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );

  // Toolbar filter values, all derived from the URL the parent owns.
  const urlQ = searchParams.get("q") ?? "";
  const urlStatus = searchParams.get("status") ?? "";
  const urlSince = searchParams.get("since");

  const selectedModels = useMemo(() => {
    const raw = searchParams.get("model") ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }, [searchParams]);

  const toggleModel = useCallback(
    (model: string) => {
      const next = new Set(selectedModels);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      updateUrl({ model: Array.from(next).join(",") || null, page: null });
    },
    [selectedModels, updateUrl],
  );
  const clearModels = useCallback(() => {
    updateUrl({ model: null, effort: null, page: null });
  }, [updateUrl]);

  const modelOptions: ModelOption[] = useMemo(
    () =>
      modelFacets
        .map((f) => ({ model: f.model, count: f.count, archived: f.archived }))
        .sort((a, b) => a.model.localeCompare(b.model)),
    [modelFacets],
  );

  // Archiving retires a model from the dropdowns project-wide. The facets are
  // server-rendered here (a by-product of the runs list), so a refresh is what
  // re-reads them — the Tasks page fetches its palette client-side and splices
  // its own state instead.
  const setModelArchivedState = useCallback(
    async (model: string, archived: boolean) => {
      try {
        await setModelArchived(projectId, model, archived);
        router.refresh();
        toast.success(archived ? "Model archived" : "Model restored");
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Failed to update model");
      }
    },
    [projectId, router],
  );

  // Effort filter — only show when exactly one model is selected and that
  // model has 2+ effort tiers (same pattern as the tasks page).
  const selectedModelArr = Array.from(selectedModels);
  const effortOptions = useMemo(() => {
    if (selectedModelArr.length !== 1) return [];
    const facet = modelFacets.find((f) => f.model === selectedModelArr[0]);
    return facet && facet.efforts.length > 1 ? facet.efforts : [];
  }, [modelFacets, selectedModelArr]);

  const selectedEfforts = useMemo(() => {
    const raw = searchParams.get("effort") ?? "";
    return new Set(raw.split(",").filter(Boolean));
  }, [searchParams]);

  const handlePageChange = useCallback(
    (newPage: number) => {
      updateUrl({ page: newPage === 0 ? null : String(newPage) });
    },
    [updateUrl],
  );

  // Compare selection (max 2 runs, sliding window when a third is picked).
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const compareIdSet = useMemo(() => new Set(compareIds), [compareIds]);
  const toggleCompare = useCallback((id: string) => {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return prev.length >= 2 ? [prev[1], id] : [...prev, id];
    });
  }, []);
  const clearCompare = useCallback(() => setCompareIds([]), []);

  const compareBatches = useMemo(
    () => compareIds.map((id) => batchRuns.find((b) => b.id === id) ?? null),
    [compareIds, batchRuns],
  );
  const overlap = useMemo(
    () =>
      compareBatches.length === 2 && compareBatches[0] && compareBatches[1]
        ? computeOverlap(compareBatches[0], compareBatches[1])
        : null,
    [compareBatches],
  );

  return (
    <div className="flex h-full w-full flex-col">
      <RunsToolbar
        urlQ={urlQ}
        urlStatus={urlStatus}
        urlSince={urlSince}
        selectedModels={selectedModels}
        selectedEfforts={selectedEfforts}
        modelOptions={modelOptions}
        effortOptions={effortOptions}
        totalCount={totalCount}
        updateUrl={updateUrl}
        onSetArchived={setModelArchivedState}
      />

      <div className="flex-1 overflow-auto">
        {sourceUnconfigured ? (
          <div className="px-6 py-10">
            <div className="px-6 py-10 text-center text-sm text-neutral-400">
              Run <code className="text-neutral-200">apo task publish</code> to publish your task catalog.
            </div>
          </div>
        ) : batchRuns.length === 0 ? (
          <div className="m-6 rounded-md border border-dashed border-border bg-card/40 p-10 text-center text-[13px] text-muted-foreground">
            <History className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
            {totalCount === 0
              ? <>No runs yet. <Link href={`/project/${projectId}/tasks`} className="text-primary underline underline-offset-4">Discover and run tasks</Link></>
              : "No runs match your filters."}
          </div>
        ) : (
          <Table density="compact">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="border-border hover:bg-transparent">
                <TableHead style={{ width: COL.chevron }} />
                <TableHead>Run</TableHead>
                <TableHead style={{ width: COL.source }} className="hidden xl:table-cell">Source</TableHead>
                <TableHead style={{ width: COL.execution }}>
                  <span className="inline-flex items-center gap-1">
                    Execution
                    <RunsModelFilter
                      options={modelOptions}
                      selected={selectedModels}
                      onToggle={toggleModel}
                      onClear={clearModels}
                      onSetArchived={setModelArchivedState}
                    />
                  </span>
                </TableHead>
                <TableHead style={{ width: COL.tasks }} className="text-right">Tasks {"\u00b7"} Pass rate</TableHead>
                <TableHead style={{ width: COL.duration }} className="text-right">Duration</TableHead>
                <TableHead style={{ width: COL.created }} className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batchRuns.map((b) => (
                <RunsRow
                  key={b.id}
                  batch={b}
                  clientNow={clientNow}
                  projectId={projectId}
                  compareSelected={compareIdSet.has(b.id)}
                  compareDisabled={compareIds.length >= 2 && !compareIdSet.has(b.id)}
                  onToggleCompare={() => toggleCompare(b.id)}
                  modelFilter={selectedModels}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <ListPagination
        totalCount={totalCount}
        page={page}
        pageSize={pageSize}
        totalPages={totalPages}
        itemName="runs"
        onPageChange={handlePageChange}
      />

      {compareIds.length > 0 && (
        <RunsCompareBar
          compareIds={compareIds}
          compareBatches={compareBatches}
          overlap={overlap}
          projectId={projectId}
          onClearCompare={clearCompare}
        />
      )}
    </div>
  );
}
