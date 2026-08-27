# Task detail scope diagnosis: where run-cohort scoping actually applies

> Wayfinder asset for [Map where run-cohort scoping actually applies today](https://github.com/samikuikka/apo/issues/167), on the map [Make the task detail page honor evidence-view scope and iterations](https://github.com/samikuikka/apo/issues/165). Diagnosed 2026-08-27. Facts only — fixes and design decisions live on the map's other tickets.

## Verdict

**The reported experience ("Opus view → task page shows DeepSeek runs") matches the pre-feature build, not current main.** The cohort carry-over (`feat(dashboard): task detail keeps the evidence-view cohort`, `96a4b51f`) landed 2026-08-25 19:54 EEST — the day before the report. Before it, every task-card click linked unscoped by design. Ephemeral stacks from that era (e.g. apo183, images built 2026-08-23) predate it entirely.

Current main is mechanically sound end-to-end (tests, live API, deployed build all verified below), but three gaps remain real today: three navigation paths still drop the scope, the scoped state is shown only as small static badges (invisible on single-model data), and status/search deliberately do not travel.

## Navigation paths into a task detail page

| Path | Source | Carries cohort? |
|---|---|---|
| Task cards on the tasks panel | `apps/dashboard/src/app/project/[projectId]/tasks/components/TaskCard.tsx:44` | **Yes** — active view's `model`/`effort`/`since` as `?model=&effort=&since=`; Main tab links stay plain |
| Run detail page → task back-links | `apps/dashboard/src/app/project/[projectId]/runs/task/[taskRunId]/page.tsx:177,242` | **No** — bare `taskDetailHref`, always all-history |
| Schedule detail → task links | `apps/dashboard/src/app/project/[projectId]/schedules/[scheduleId]/schedule-detail-client.tsx:383,413` | **No** |
| Trace detail → task link | `apps/dashboard/src/components/trace-detail/TraceDetailView.tsx:158` | **No** |
| Task page's own "All history" link | `apps/dashboard/src/app/project/[projectId]/tasks/[...taskId]/page.tsx:146` | Resets by design |
| Bookmarked / shared URL | — | Only whatever is in the URL |

Related: the Runs nav link (`apps/dashboard/src/components/dashboard-shell.tsx:86`) does carry the cohort — to the Runs page, not the task page. Status filter and text search are tasks-page client state and deliberately do not travel (`run-cohort.ts` header comment).

## Verification evidence

- **Frontend carry-over**: `pnpm vitest run` on `tasks-run-cohort.test.tsx`, `dashboard-shell-run-cohort.test.tsx`, `runs-carried-filters.test.tsx` — 18/18 pass, including "carries the view cohort into the task detail link" and "points at the unfiltered run list while Main is active". (A live in-app-browser click-through was attempted on the docker stack but the browser session wedged; the integration tests exercise the same component tree.)
- **Backend scoping** (live, docker stack, project `e06c87103f95`, task `real-agent/documents/data-extraction`, 1 Gemini run): no `model` → 1 run; `model=google/gemini-2.5-flash-lite` → 1 run; `model=deepseek/…` → 0 runs; `model=GOOGLE/GEMINI-2.5-FLASH-LITE` → 0 runs (**exact, case-sensitive**); `status=passed` → 0 runs (single exact status, works; the run is `failed`). Verified via a temporary project-bound API key (created under `admin@test.com`, deleted immediately after).
- **Deployed build**: `apo-frontend-1` image (built 2026-08-25 20:06, twelve minutes after `96a4b51f`) contains the cohort strings in `/app/apps/dashboard/.next` — the running stack has the feature.
- **Data reality**: the docker stack has no mixed-model task (agent-demo: 4 DeepSeek runs; `e06c87103f95`: 2 Gemini runs) and no Opus runs at all; the dev DB has no agent-task runs. The reported Opus-vs-DeepSeek scenario is not reproducible on either current stack's data.

## Perception findings

Even on the carrying path, the affordance is weak: the scope renders as one line of small static badges ("Run history scoped to: …") plus an "All history" reset, below the task header. On single-model projects the scoped and unscoped lists are identical, so the feature is invisible. A user who filtered by **status** or **search** on the tasks page (which don't travel, by design) and then clicks a task gets an unscoped-looking list — a second plausible route to "the view didn't follow me" reports.

One non-issue worth recording: view model values come from the same `configured_model` field the runs query matches (`agent-task-run-config-facets`), so exact/case-sensitive matching cannot silently zero out a legitimately-created view.

## What this leaves for the interaction-model decision

The decision ticket ([Decide the task detail page's filtering interaction model](https://github.com/samikuikka/apo/issues/169)) now has its inputs: the three dropping paths above (should they carry, and what scope — a run-detail back-link arguably wants the run's own model), the badges-only affordance gap, the status/search question, and the fact that the mechanism (URL cohort + backend filtering) is proven and merely needs an interactive surface.
