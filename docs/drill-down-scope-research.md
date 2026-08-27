# Drill-down scope research: how other tools filter an item's own history

> Wayfinder asset for [Research how comparable tools scope drill-down run lists](https://github.com/samikuikka/apo/issues/166), on the map [Make the task detail page honor evidence-view scope and iterations](https://github.com/samikuikka/apo/issues/165). Surveyed 2026-08-27, official documentation only; every fact cites its source. This file records findings — the design decisions live on the map's tickets.

## The question

apo's tasks panel has saved views (`model`/`effort`/`since`). Clicking a task opens its detail page, whose run list should respect the view the user arrived with — and offer the same interactive control. Today the cohort travels in URL params (`run-cohort.ts`) but renders only as static badges. We surveyed six tools for how they handle: scope inheritance into drill-downs, interactive detail-page filtering, URL state, repeated-execution grouping, reset/breadcrumbs, and facet counts.

## Tool-by-tool findings

### LangSmith — inherit-and-escape

- **The only tool that documents exactly apo's question**: opening a trace's Details view from a filtered list shows matches only, by default — "By default, only the runs that match the filters will be shown," with an explicit view toggle: **Filtered Only / Show All / Most relevant**. ([filter-traces-in-application](https://docs.langchain.com/langsmith/filter-traces-in-application))
- Mechanism is the project's active filter set, not URL params; saved filters are per-project. (same page)
- Experiment tables have rich in-place filters: per-column dropdowns, filter/group by models, prompts, tools, metadata. ([analyze-an-experiment](https://docs.langchain.com/langsmith/analyze-an-experiment))
- URL filter state: not documented. Sharing is via public share links or copying the filter as a query-language string. ([manage-trace](https://docs.langchain.com/langsmith/manage-trace))
- Repetition: a "Repetition Summary" over repeated runs, with per-repetition traces. ([analyze-an-experiment](https://docs.langchain.com/langsmith/analyze-an-experiment))
- Facet counts, breadcrumbs, explicit reset: not documented.

### Braintrust — independent contexts, server-side views

- No documented scope inheritance into detail views; logs table, experiment table, and trace viewer each carry **their own independent filter system** (Basic point-and-click + SQL tabs). ([filter](https://braintrust.dev/docs/observe/filter), [interpret-results](https://braintrust.dev/docs/evaluate/interpret-results))
- Persistence is server-side **saved table views** (personal → project → org default hierarchy), shared with all project members — not URL state. ([view-logs](https://braintrust.dev/docs/observe/view-logs))
- Notable **reverse drill**: clicking a span in a trace pushes a filter onto the logs list. ([filter](https://braintrust.dev/docs/observe/filter))
- URL state carries item identity only (`?r=<root_span_id>`, object permalinks), never filters. ([examine-traces](https://braintrust.dev/docs/observe/examine-traces))
- Iteration notions: **trials** (same input run N times, grouped into collapsible rows with aggregate headers) and append-only **row versions** for retries ("The UI displays the latest version per row"). ([advanced-evaluations](https://braintrust.dev/docs/evaluate/advanced-evaluations), [retry-safe-eval-workers](https://braintrust.dev/docs/kb/retry-safe-eval-workers-with-stable-row-ids))

### Honeycomb — one query object that travels

- Drill-downs **reuse the originating query**: span context-menu actions "create a new query that re-uses the original query but adds the selected clause" (docs even warn the inherited query can become self-contradictory). ([explore-traces](https://docs.honeycomb.io/investigate/analyze/explore-traces))
- The whole query — calculations, filters, breakdowns, time range, viz — serializes into one URL param: `?query=<query_json>` (with a documented ~2000-char URL-length caveat). ([share-a-query](https://docs.honeycomb.io/investigate/collaborate/share-query))
- No occurrence grouping in trace detail ("no feature for related, similar, or grouped traces"); no facet panel — the analog is BubbleUp's selection-vs-baseline bar heights. ([explore-traces](https://docs.honeycomb.io/investigate/analyze/explore-traces), [identify-outliers](https://docs.honeycomb.io/investigate/analyze/identify-outliers))
- Breadcrumbs / filtered-subset indicator: not documented.

### Datadog — composed context links + visible scope

- Drill-down filters are **explicitly composed and documented**: context links embed "a filter that combines the widget filter(s) with template variables… and, for grouped-by queries, the one series users click on," plus the time range. ([context-links](https://docs.datadoghq.com/dashboards/guide/context-links/))
- Scope stays **visible**: template-variable chips in the dashboard header; facet selections "and URL automatically reflect your selections." ([template-variables](https://docs.datadoghq.com/dashboards/template_variables/), [facets](https://docs.datadoghq.com/tracing/trace_explorer/facets/))
- **Facet counts re-scope**: "Open a facet to see a summary of its content for the scope of the current query." ([facets](https://docs.datadoghq.com/tracing/trace_explorer/facets/))
- Saved Views have explicit reset semantics: "Reload your default view," "Reset… to Datadog's defaults." ([saved-views](https://docs.datadoghq.com/logs/explorer/saved_views/))
- Repetition grouping is first-class where it matters: fingerprinted **issues** with occurrence counts over time. ([error-tracking](https://docs.datadoghq.com/tracing/error_tracking/))

### Langfuse — never leave the list (added for the interaction-model decision)

- **No filter inheritance into detail pages, by design**: full-page detail URLs carry identity + point-in-time params only (`/traces/{id}?timestamp=…&observation=…`). ([url](https://langfuse.com/docs/observability/features/url), code-verified peek param handling in `web/src/components/table/peek/`)
- Instead, drill-down opens as a **non-modal peek panel over the still-mounted filtered table** — list state (filters, sort, pagination, search) explicitly persists while you J/K through items. (code-verified: `web/src/components/table/peek/README.md`)
- **Filters are always URL-serialized** ("sending someone the link reproduces the exact filtered view") and **saved views get their own URLs**; facet values show counts that respect active filters, so a picked value "never comes back with no results". ([filter-search-bar](https://langfuse.com/docs/observability/features/filter-search-bar), [save-table-views](https://langfuse.com/changelog/2025-05-20-save-table-views))
- In-detail narrowing exists (log-level filter, observation search). When scope must travel across real navigation (human eval), it's frozen into an explicit **annotation queue**, not inherited from live filters. ([annotation-queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues))
- v4 goes furthest structurally: "a trace is just the set of rows sharing a `trace_id`" — drilling in *is* applying a filter on one observations table. ([v4 FAQ](https://langfuse.com/faq/all/explore-observations-in-v4))

### Weights & Biases — server-side views, no URL scope

- Run detail does not inherit table filters (standalone run-scoped URL). ([view-logged-runs](https://docs.wandb.ai/models/runs/view-logged-runs))
- View state lives in server-side saved views (personal + team-editable); URL-param sharing of view state was a long-standing open request, never shipped. ([workspaces](https://docs.wandb.ai/models/track/workspaces), [wandb#954](https://github.com/wandb/wandb/issues/954))
- Filter-aware counts exist: "6 of 18 listed" against the active filter; panels update with the filter. ([filter-runs](https://docs.wandb.ai/models/runs/filter-runs), [run-comparer](https://docs.wandb.ai/models/app/features/panels/run-comparer))
- Grouping is orthogonal labeling: `group=` cuts across sweeps; sweep = orchestrated container of runs; default workspaces group with mean aggregation. ([grouping](https://docs.wandb.ai/models/runs/grouping), [sweep-walkthrough](https://docs.wandb.ai/models/sweeps/walkthrough))

### GitHub Actions + Playwright — numbered attempts, derived statuses

- **GitHub Actions**: a re-run is a numbered **attempt** of a stable run id — `github.run_attempt` "begins at 1… and increments with each re-run"; the UI shows a **Latest dropdown** to pick previous attempts; REST and UI address attempts as `/attempts/{n}`. ([contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts), [re-run-workflows-and-jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs), [workflow-runs API](https://docs.github.com/en/rest/actions/workflow-runs))
- **Playwright**: attempt sequences yield derived statuses — "flaky" = failed first, passed on retry — with per-attempt artifacts retained for comparison. ([test-retries](https://playwright.dev/docs/test-retries))
- Neither carries list filters into the drill-down (run URLs are absolute).

## Comparison

| Question | LangSmith | Braintrust | Honeycomb | Datadog | W&B | GHA |
|---|---|---|---|---|---|---|
| Detail inherits list scope? | **Yes, documented** (Filtered-Only default) | No (independent contexts) | Yes (query reuse) | Yes (composed context links) | No | No |
| Interactive filters in detail? | Yes (same filter system) | Yes (own Basic/SQL) | Yes (span → WHERE/GROUP BY) | Yes (side-panel search, one-click) | Limited (single-run search) | No |
| Scope in URL? | No (share links / query strings) | Identity only | **Yes** (`?query=json`) | **Yes** (facets + `tpl_var_`) | No (server-side views) | Attempt path only |
| Repeated-exec grouping | Repetition Summary | Trials bucketed by input; row versions | None (high-cardinality) | Fingerprinted issues w/ counts | Groups across sweeps | **Attempts `/N`, Latest default** |
| Reset / breadcrumb | Show-All toggle | Built-in views as de-facto reset | Not documented | **Explicit saved-view reset** | Not documented | Latest dropdown |
| Facet counts re-scope? | No | Not documented | BubbleUp bars only | **Yes, documented** | **Yes ("6 of 18")** | n/a |

**Uncharted territory**: no surveyed tool documents breadcrumbs that preserve filters on back-navigation, a "you are viewing a filtered subset" badge, or scope-aware facet counts on a *detail* page (only on list pages). Whatever apo does there, it sets its own terms. Notably, apo's URL-param cohort is already a stronger sharing contract than LangSmith, Braintrust, or W&B document — the gap is purely in affordance.

## Candidate patterns for apo

### Pattern A — Inherit and escape *(LangSmith + Datadog)*

Keep the URL-carried cohort as the mechanism (already built), but make it a first-class, interactive scope on the detail page: render the cohort as the same filter controls as `EvidenceViewsBar` (editable, not badges), show **filtered-by-default with an explicit "All history" escape** (the reset link already exists — it becomes the escape hatch), keep scope chips visible at all times, and make filter counts re-scope (W&D/Datadog precedent: "6 of 18"). Lowest-cost: no new scope concept, no server-side state, URLs stay shareable.

### Pattern B — Global persistent view scope *(Braintrust / W&B)*

Promote saved views to a scope selector present on every relevant page (tasks list, task detail, Runs); the active view is session- or server-persistent global state. Strongest continuity ("I am in my Opus cohort everywhere"), but requires deciding per-user vs shared views, new storage semantics, and what happens on deep links that conflict with the global scope. Highest cost; apo's views are per-user today, Braintrust's are team-shared.

### Pattern C — Independent per-page filters *(Braintrust detail tables)*

Drop carry-over; the detail page gets its own filter set with its own defaults. Simplest mental model per page, but loses the user's actual complaint: arriving at a task *from* a view and wanting to stay in it.

### Iteration-model input *(feeds the iteration decision)*

The CI analogy is the sharpest: model each batch pass over a task as **iteration N** (1-based, incrementing), addressable in the URL (GHA `/attempts/N`), with the run list defaulting to a **Latest-first view and an iteration switcher**. Playwright suggests a derived status dimension (failed-then-passed ≠ always-passed); Braintrust suggests collapsing same-config repeats into groups with aggregate headers. Whether "iteration" should be exposed in `AgentTaskRunSummary` or derived from `batch_run_id` order is the open data-model question on the map.

## Pointers for the open tickets

- [Decide the task detail page's filtering interaction model](https://github.com/samikuikka/apo/issues/169): weigh A vs B vs C; the research favors A as baseline (documented precedent + apo's existing mechanism), with Datadog-style visible chips and re-scoped counts as polish.
- [Decide the iteration model for task run history](https://github.com/samikuikka/apo/issues/170): start from GHA attempts + Latest-default; consider Braintrust-style same-config collapsing and Playwright-style derived statuses.
