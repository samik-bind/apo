# Unified filter row — UI prototype

> Question: what should ONE shared filter row look like, so the Tasks list, a
> task's run history, and the Runs page stop shipping three different filter
> UIs for the same dimensions (status / model / effort / date)?
>
> **Status: awaiting verdict.** Flip the variants, pick one (or a mix), then
> fold the winner into a real component and delete this folder. See
> "Handoff" below.

## How to view

Dev server (main-stack backend, dev sign-in works):

    http://127.0.0.1:3101/project/<id>/tasks?variant=A   # or B, C
    http://127.0.0.1:3101/project/<id>/runs?variant=A
    http://127.0.0.1:3101/project/<id>/tasks/<taskId>?variant=A

- `?variant=` stays in the URL (shareable). The floating bottom bar or the
  ←/→ keys cycle A → B → C.
- The bar is fully functional on Tasks and task-detail (state really filters).
  On Runs, model/effort/date/search are real; **status is display-only**
  because `GET /v1/agent-task-batch-runs` accepts a single status value today
  (see "Findings").

## The variants

| | Shape | Status interaction | State summary |
|---|---|---|---|
| **A** — Flat chips | everything visible in one dense row | multi-select toggle chips with dots + counts | the controls themselves |
| **B** — Filters menu + chips | one "Filters" entry point; removable active-filter chips below | multi-select checkboxes inside the menu | chips |
| **C** — Segmented + Scope | status segmented control always visible; model/effort/date in a "Scope" menu | **single-select** (probes whether multi is worth the width) | count badges on triggers |

All three are the same controlled component contract
(`PrototypeFilterProps` in `shared.tsx`): the page keeps owning its state (URL
or local) and supplies its own status vocabulary — task (Passed/Failed/Errored/
Not Run), task-run (Passed/Failed/Errored), batch (Queued/Running/Completed/
Partial/Failed/Error).

## Findings so far (from the research pass)

- Four status vocabularies exist in prod today: task list
  `passed/failed/errored/idle`, task detail `passed/failed/error`, runs
  `all/passed/failed/error/running` (dropdown), traces `success/warning/error`
  (param exists, no UI). `errored` vs `error` is inconsistent across task list
  and task detail for the same concept.
- **Real bug**: the Runs page offers a "Passed" status filter, but batch runs
  are never `passed` (they are `queued/accepted/running/completed/partial/
  failed/error`), and the backend does a plain equality match — the option
  silently filters out everything.
- Duplication to fold when unifying: the h-7 model trigger button ×4,
  effort+date picker pair ×2 (with three separate `__any__` sentinels),
  URL-write helper ×4, debounced search ×3, status vocab maps ×4, multi-value
  URL encoding in two conventions (comma-joined vs repeated `?status=`).
- Tasks-list status is client-local state (not shareable); runs/task-detail
  are URL-backed. A unified row should pick one story (URL) for all pages.
- `run-cohort.ts` deliberately excludes status from cross-page travel; a
  unified vocabulary per entity keeps that boundary clean.

## Handoff (fill in after flipping through the variants)

- Winning variant (or mix): ___
- Multi-select status everywhere, or single-select on Runs? ___
- Keep per-entity vocabularies (recommended) or unify labels? ___
- Where do counts come from on Runs/Task-detail (needs backend facets)? ___

## Fold-in checklist (once a direction is picked)

1. Promote the winning variant's layout into a real `FilterBar` component
   (rewrite; prototype code is intentionally unpolished).
2. One shared model trigger + one URL-write helper + one multi-value encoding
   (`a,b` — matches Runs/Traces today) across all pages.
3. Make Tasks' status/search URL-backed instead of local state.
4. Backend: accept `status: list[str]` on `GET /v1/agent-task-batch-runs` and
   fix its option list to the real batch vocabulary (kills the "Passed" no-op).
5. Delete this folder and the `?variant=` gates in the three host pages.
