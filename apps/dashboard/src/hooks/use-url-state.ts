"use client";

/**
 * URL-backed view state.
 *
 * Lets a component read/write a piece of UI state from the query string so the
 * page can be shared, bookmarked, or restored via back/forward. Mirrors the
 * pattern established by `UrlSelectionContext` (used by the trace workspace):
 * writes are shallow (`window.history.replaceState` via
 * `shallow-search-params`), so the URL updates and `useSearchParams` consumers
 * re-render without the server component re-running — a `router.replace` on
 * these `force-dynamic` pages would re-fetch the page's entire data set per
 * click. Only use these hooks for params the server component does NOT read;
 * server-driven params (pagination, sorting, filters) must keep using router
 * navigation.
 *
 * NOTE: `useSearchParams` requires a <Suspense> boundary above any page that
 * renders these hooks at the top level. The pages that consume them wrap their
 * client tree in <Suspense> already.
 */

import { useCallback } from "react";
import { useSearchParams } from "next/navigation";

import {
  setSearchParamShallow,
  updateSearchParamsShallow,
} from "@/lib/shallow-search-params";

/**
 * Read/write a single-valued query param.
 *
 * @param key      Query-string key.
 * @param fallback Value used when the param is absent/empty.
 */
export function useUrlParam(key: string, fallback = ""): [string, (value: string | null) => void] {
  const searchParams = useSearchParams();
  const value = searchParams.get(key) ?? fallback;

  const setValue = useCallback(
    (next: string | null) => {
      setSearchParamShallow(key, next);
    },
    [key],
  );

  return [value, setValue];
}

/**
 * Read/write a set of values encoded as a comma-separated query param
 * (e.g. `?check=a,b,c`). Useful for "expanded rows" style state where more
 * than one item can be open at once.
 */
export function useUrlParamSet(key: string): [
  Set<string>,
  (value: string, open?: boolean) => void,
  () => void,
] {
  const searchParams = useSearchParams();

  const raw = searchParams.get(key) ?? "";
  const values = parseCsvSet(raw);

  // Reads the live URL inside the mutation, so rapid toggles compose instead
  // of clobbering each other via a stale hook snapshot.
  const toggle = useCallback(
    (value: string, open?: boolean) => {
      updateSearchParamsShallow((params) => {
        const next = parseCsvSet(params.get(key) ?? "");
        const shouldOpen = open ?? !next.has(value);
        if (shouldOpen) next.add(value);
        else next.delete(value);
        const joined = setToParam(next);
        if (joined) params.set(key, joined);
        else params.delete(key);
      });
    },
    [key],
  );

  const clearAll = useCallback(() => {
    setSearchParamShallow(key, null);
  }, [key]);

  return [values, toggle, clearAll];
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Parse a comma-separated query param into a Set of trimmed, non-empty values. */
function parseCsvSet(raw: string): Set<string> {
  return new Set(
    raw.split(",").flatMap((s) => {
      const t = s.trim();
      return t ? [t] : [];
    }),
  );
}

function setToParam(set: Set<string>): string | null {
  const joined = Array.from(set).filter(Boolean).join(",");
  return joined || null;
}
