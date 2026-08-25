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

import {
  EMPTY_RUN_COHORT,
  type RunCohort,
} from "@/lib/run-cohort";

interface RunCohortStore {
  cohort: RunCohort;
  setCohort: (cohort: RunCohort) => void;
}

const RunCohortContext = createContext<RunCohortStore | null>(null);

/** Lets a page publish its cohort to navigation rendered by the same shell. */
export function RunCohortProvider({ children }: { children: ReactNode }) {
  const [cohort, setCohortState] = useState<RunCohort>(EMPTY_RUN_COHORT);
  const setCohort = useCallback((next: RunCohort) => {
    setCohortState((previous) =>
      previous.model === next.model &&
      previous.effort === next.effort &&
      previous.since === next.since
        ? previous
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

/** The cohort published by the current page, or an empty one outside a shell. */
export function useRunCohort(): RunCohort {
  return useContext(RunCohortContext)?.cohort ?? EMPTY_RUN_COHORT;
}

/** Publish a cohort while the calling page is mounted and clear it on exit. */
export function usePublishRunCohort(cohort: RunCohort): void {
  const setCohort = useContext(RunCohortContext)?.setCohort;
  const { model, effort, since } = cohort;
  useEffect(() => {
    if (!setCohort) return;
    setCohort({ model, effort, since });
    return () => setCohort(EMPTY_RUN_COHORT);
  }, [model, effort, since, setCohort]);
}
