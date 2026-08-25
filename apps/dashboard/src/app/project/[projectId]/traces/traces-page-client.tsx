"use client";

import { Suspense, useEffect, useRef } from "react";

/**
 * TracesPageClient - Client component for the canonical traces page.
 *
 * Provides the SelectionProvider and renders:
 * - Page-level layout (Filters + Table)
 * - Trace panel overlay (slides in when a trace is selected)
 *
 * Which trace is open in the side panel is synced to ?trace= so the panel
 * survives refresh and is shareable. The within-panel selection (call/view/tab)
 * is handled separately by the workspace.
 */

import { SelectionProvider, useSelection } from "@/components/trace-detail";
import { TracesPageLayout } from "@/components/trace-detail";
import type { TraceFilterOptions } from "@/components/trace-filter-controls";
import { TracePanel } from "@/components/trace-detail/TracePanel";
import type { TraceSummary, TraceSessionSummary } from "@/lib/traces-api";
import { useUrlParam } from "@/hooks/use-url-state";
import { TracesTablePanel } from "./TracesTablePanel";
import { SessionsTablePanel } from "./SessionsTablePanel";
// PROTOTYPE — throwaway mobile-UX spike; delete with its gate when decided.
import { TracesMobilePrototype, type PrototypeVariant } from "./prototype-mobile";

interface PaginationData {
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface TracesPageClientProps {
  projectId: string;
  prototypeVariant?: PrototypeVariant;
  traces: TraceSummary[];
  error?: string | null;
  pagination?: PaginationData;
  filterOptions?: TraceFilterOptions;
  sessions?: TraceSessionSummary[];
  sessionsPagination?: PaginationData;
  view?: string;
}

/**
 * Bridges the side-panel selection to ?trace= in the URL. Reads once on mount
 * (so a shared link opens the panel) and writes back whenever the user picks a
 * different trace or closes the panel. Lives inside the SelectionProvider.
 */
function TraceSelectionUrlSync() {
  const { selectedRunId, selectRun } = useSelection();
  const [traceParam, setTraceParam] = useUrlParam("trace");

  // Mount-time snapshots. A shared ?trace= should open the panel exactly once,
  // on mount — if this effect re-ran with the live `traceParam` later, a stale
  // URL value could clobber a selection the user just made. useRef() only
  // initializes from its argument on the first render, which is exactly the
  // mount-time read we want, and refs are exempt from effect deps.
  const initialTraceParamRef = useRef(traceParam);
  const initialSelectedRunIdRef = useRef(selectedRunId);

  // On mount: a shared ?trace= opens the panel. Subsequent URL updates flow
  // through the effect below instead.
  useEffect(() => {
    const initialTraceParam = initialTraceParamRef.current;
    if (initialTraceParam && initialTraceParam !== initialSelectedRunIdRef.current) {
      selectRun(initialTraceParam);
    }
  }, [selectRun]);

  // When the user opens/closes a trace, mirror it into the URL.
  useEffect(() => {
    setTraceParam(selectedRunId);
  }, [selectedRunId, setTraceParam]);

  return null;
}

export function TracesPageClient({
  projectId,
  prototypeVariant,
  traces,
  error,
  pagination,
  filterOptions,
  sessions,
  sessionsPagination,
  view = "list",
}: TracesPageClientProps) {
  return (
    <SelectionProvider projectId={projectId}>
      <Suspense fallback={null}>
        <TraceSelectionUrlSync />
      </Suspense>
      <div className="relative h-full w-full">
        {prototypeVariant ? (
          // PROTOTYPE branch — mobile-UX spike, delete when decided.
          <Suspense fallback={null}>
            <TracesMobilePrototype
              variant={prototypeVariant}
              projectId={projectId}
              traces={traces}
              error={error}
              filterOptions={filterOptions}
            />
          </Suspense>
        ) : (
        /* Suspense: TracesPageLayout reads the filter state from the URL via
            useFilters (useSearchParams), which needs a boundary above it. The
            table panels keep their own inner boundaries. */
        <Suspense fallback={null}>
          <TracesPageLayout filterOptions={filterOptions}>
            {view === "sessions" && sessions ? (
              <Suspense fallback={null}>
                <SessionsTablePanel
                  sessions={sessions}
                  pagination={sessionsPagination}
                  onSelectSession={(sessionId) => {
                    const params = new URLSearchParams(window.location.search);
                    params.set("session_id", sessionId);
                    params.delete("view");
                    window.location.href = `/project/${projectId}/traces?${params.toString()}`;
                  }}
                />
              </Suspense>
            ) : (
              <Suspense fallback={null}>
                <TracesTablePanel
                  projectId={projectId}
                  traces={traces}
                  error={error}
                  pagination={pagination}
                />
              </Suspense>
            )}
          </TracesPageLayout>
        </Suspense>
        )}

        {/* Suspense: TracePanel renders TraceWorkspace, which reads ?q via
            useSearchParams. */}
        <Suspense fallback={null}>
          <TracePanel />
        </Suspense>
      </div>
    </SelectionProvider>
  );
}
