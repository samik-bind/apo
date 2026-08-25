# PROTOTYPE — mobile traces UX (throwaway)

**Question:** what should mobile traces look like — an adapted table, a
status-first feed, or search-first rows? (Not "how do we squeeze the desktop
table". The mobile job is monitor/triage/search; deep analysis stays on
desktop.)

**Where:** `/project/<id>/traces?variant=A|B|C` (login required). Real demo
data, real URL-driven filters, read-only. The floating bar at the bottom
switches variants (also ←/→ keys). Dev only — the bar and the gate never
render in production builds.

## Variants

| Key | Name | Shape |
|---|---|---|
| A | Compact table | Trimmed table (status + name + duration + when), horizontally scrollable active-filter chips, "Filters" pill with count badge → bottom sheet with touch-sized controls. Closest to today's UI, mobile-tuned. |
| B | Triage feed | No table. Segmented All/Failed/Starred control, status-first cards (model, calls, errors, duration, time). The "monitoring" answer. |
| C | Search first | Search is the screen. One-line rows expand inline (model, env, tokens, tags) with an "Open trace" action. The "people search, they don't facet-filter" answer. |

All three share: bottom-sheet filters (thumb zone, not a left drawer), chip
row for visible filter state, tap-a-row opens the real TracePanel.

## Verdict

**Pending.** Flip through at phone width (or DevTools 390×844) and note which
one feels right — or "header from B with rows from C" style mix-and-match.
Write the verdict here, fold the winner into `TracesTablePanel` /
`TracesPageLayout` properly, then delete `prototype-mobile.tsx`, this file,
and the `prototypeVariant` gate in `page.tsx` + `traces-page-client.tsx`.
