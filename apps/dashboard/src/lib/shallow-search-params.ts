/**
 * Shallow URL search-param updates — no server round-trip.
 *
 * Next.js integrates the native History API: calling
 * `window.history.replaceState` updates the URL and re-renders
 * `useSearchParams()` consumers **without** re-fetching the page's RSC
 * payload. `router.replace`, by contrast, re-runs the server component on
 * every call — on a `force-dynamic` page like the trace detail view that
 * means re-fetching the entire trace from the backend just to move a
 * selection highlight.
 *
 * Use these for ephemeral UI state stored in the URL (selected span, active
 * view/tab, search text). Use `router.push`/`router.replace` only when the
 * server actually needs to re-render with the new params (pagination,
 * sorting, filters on list pages).
 *
 * Client-only: touches `window`, so callers must be event handlers or
 * effects, never render bodies.
 */

/** Apply an arbitrary mutation to the current search params, shallowly. */
export function updateSearchParamsShallow(
  mutate: (params: URLSearchParams) => void,
): void {
  const params = new URLSearchParams(window.location.search);
  mutate(params);
  const qs = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${qs ? `?${qs}` : ""}`,
  );
}

/** Set (or, with null/empty, remove) a single search param, shallowly. */
export function setSearchParamShallow(
  key: string,
  value: string | null,
): void {
  updateSearchParamsShallow((params) => {
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  });
}
