/**
 * The run cohort — which model, effort tier, and date window a page is showing.
 *
 * Tasks and Runs answer different questions about the same cohort, and they
 * hold it in different places: Tasks in the active evidence-view tab and Runs
 * in the URL. This value object is the small, framework-free handoff between
 * those two representations.
 *
 * Status and search deliberately do not travel: status has different meanings
 * on the two pages, and their search boxes match different fields.
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

/**
 * Append a cohort as the query parameters the Runs page reads. An empty cohort
 * leaves the href untouched, so a plain navigation link stays plain.
 */
export function hrefWithRunCohort(href: string, cohort: RunCohort): string {
  const params = new URLSearchParams();
  if (cohort.model) params.set("model", cohort.model);
  if (cohort.effort) params.set("effort", cohort.effort);
  if (cohort.since) params.set("since", cohort.since);
  const query = params.toString();
  if (!query) return href;
  return `${href}${href.includes("?") ? "&" : "?"}${query}`;
}
