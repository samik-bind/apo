"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The run cohort — which model, effort tier, and date window you are currently
 * looking at.
 *
 * Tasks and Runs answer different questions about the same cohort, and they
 * hold it in different places: Tasks in the active evidence-view tab (state,
 * persisted server-side), Runs in the URL. Navigating between them used to
 * drop it, so a Tasks page narrowed to one model landed on an unfiltered run
 * list and the filters had to be re-picked by hand.
 *
 * The handoff is one-way and explicit: the page that owns a cohort publishes
 * it while mounted, and nav links flagged `carriesRunCohort` append it as the
 * query params the Runs page already reads. Leaving the publishing page clears
 * it, so a cohort never survives as invisible state — whatever is applied is
 * visible in the Runs toolbar and clearable there.
 *
 * The Tasks status filter and search box do not travel: `status` means the
 * last outcome of a task on one side and a batch's state on the other, and
 * search matches task names on one side, run ids/environments on the other.
 */
export interface RunCohort {
  model: string | null;
  effort: string | null;
  since: string | null;
}

export const EMPTY_RUN_COHORT: RunCohort = {
  model: null,
  effort: null,
  since: null,
};

export function isEmptyRunCohort(cohort: RunCohort): boolean {
  return (
    cohort.model === null && cohort.effort === null && cohort.since === null
  );
}

/**
 * Append a cohort to a link as the query params the Runs page reads. An empty
 * cohort leaves the href untouched, so a plain link stays plain.
 */
export function hrefWithRunCohort(href: string, cohort: RunCohort): string {
  if (isEmptyRunCohort(cohort)) return href;
  const params = new URLSearchParams();
  if (cohort.model) params.set("model", cohort.model);
  if (cohort.effort) params.set("effort", cohort.effort);
  if (cohort.since) params.set("since", cohort.since);
  const qs = params.toString();
  if (!qs) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${qs}`;
}

interface RunCohortStore {
  cohort: RunCohort;
  setCohort: (cohort: RunCohort) => void;
}

const RunCohortContext = createContext<RunCohortStore | null>(null);

export function RunCohortProvider({ children }: { children: ReactNode }) {
  const [cohort, setCohortState] = useState<RunCohort>(EMPTY_RUN_COHORT);
  const setCohort = useCallback((next: RunCohort) => {
    // Identical cohorts must not produce a new object: the provider sits above
    // every page, so a fresh value would re-render the whole shell on each
    // publish.
    setCohortState((prev) =>
      prev.model === next.model &&
      prev.effort === next.effort &&
      prev.since === next.since
        ? prev
        : next,
    );
  }, []);
  const value = useMemo(() => ({ cohort, setCohort }), [cohort, setCohort]);
  return (
    <RunCohortContext.Provider value={value}>
      {children}
    </RunCohortContext.Provider>
  );
}

/** The published cohort, or an empty one outside a provider. */
export function useRunCohort(): RunCohort {
  return useContext(RunCohortContext)?.cohort ?? EMPTY_RUN_COHORT;
}

/**
 * Publish `cohort` for as long as the calling component is mounted. Unmounting
 * clears it, so leaving the page that owns the cohort ends the handoff.
 */
export function usePublishRunCohort(cohort: RunCohort): void {
  const setCohort = useContext(RunCohortContext)?.setCohort;
  const { model, effort, since } = cohort;
  useEffect(() => {
    if (!setCohort) return;
    setCohort({ model, effort, since });
    return () => setCohort(EMPTY_RUN_COHORT);
  }, [model, effort, since, setCohort]);
}
