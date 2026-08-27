# Task iteration structure: what apo's run data supports today

> Wayfinder asset for [Map what iteration structure apo's run data supports today](https://github.com/samikuikka/apo/issues/168), on the map [Make the task detail page honor evidence-view scope and iterations](https://github.com/samikuikka/apo/issues/165). Investigated 2026-08-27 against code and the live docker-stack DB. Facts only — the iteration model decision lives in [Decide the iteration model for task run history](https://github.com/samikuikka/apo/issues/170).

## The three candidate meanings of "iteration", tested against reality

### 1. `sequence_index` is NOT an iteration number

`AgentTaskRunDB.sequence_index` is the task's **position in its batch's sequential execution order**. Verified live: the demo project's one 4-task batch (`selection_type='all'`) holds runs with `sequence_index` 0,1,2,3 across its four tasks; every single-task `caller-task` batch holds `sequence_index=0`. It exists for sequential leasing (`execution_leases.py`: a lower-index attempt must be terminal before the next claims) and projection ordering (`agent_task_projection.py:168`).

It is not exposed in `AgentTaskRunSummary` because nothing UI-facing needs in-batch order. Exposing it as an "iteration" would mislabel two runs of the same task in different batches as "0" and "0".

### 2. "A batch = one iteration" is only true at the suite level

Batches come in (at least) two shapes, distinguishable today:

- **Set-level batches** (`selection_type='all'`, plus grep/folder selections) — a pass over many tasks; `requested_by_user_id` set for dashboard-initiated runs. Here "batch N" genuinely means "the Nth pass of the suite".
- **`caller-task` batches** — single-task executions from the SDK caller flow (no requesting user). The live DB holds 10 of these vs 1 set-level batch. These are executions of one task, not passes of a set.

So a naive "iteration = Nth batch of the project" breaks when caller batches interleave with suite passes. A suite-level iteration ordinal (if wanted on the tasks page) must count only set-level batches.

### 3. Task-level iteration is cleanly derivable today — no schema change

For a single task, **one run per batch is an invariant of batch creation** (every multi-run task in the live DB has `runs == batches`, 1:1; `execution_queue` creates one run per selected task). Therefore:

> **Iteration N of a task = the Nth run, ordered by `started_at` (tie-break `id`, nulls last) = the Nth batch containing the task.**

Derived on read (SQL window function or client-side over the already-fetched run list — the task detail page already loads all runs). Cost: none at rest, small at read time. Risks: ordinals shift if runs are ever deleted (no run-deletion surface exists today); ties broken by `id` keep it deterministic; not-yet-started runs (`started_at` NULL) sort last.

**Config-grouped variant** (Braintrust-style trials): ordinal within `(configured_model, configured_effort)` — "the 3rd time this task ran on Opus". Same derivation, grouped. This matches how a model-filtered cohort view would want iterations counted.

## Live re-execution reality (docker stack, 2026-08-27)

| Task | Runs | Batches | Spread | Statuses |
|---|---|---|---|---|
| `docs-audit-stub` | 3 | 3 | 4 minutes | passed → failed → passed |
| `judge-flip-probe` | 2 | 2 | 34 seconds | — |
| `markdown-deliverable` | 2 | 2 | 15 seconds | — |
| `real-agent/documents/data-extraction` | 2 | 2 | 1 day | — |

`docs-audit-stub` is the canonical shape: three single-task batches minutes apart, flipping outcome — an "iter 1/2/3" label case **and** a Playwright-style derived-status case ("flaky" = failed then passed) in current data. Three schedules exist but zero occurrences have fired, so scheduled-batch labeling is schema-ready (occurrences link `batch_run_id`) but data-untested.

Batch-origin signals available today: `selection_type`, `requested_by_user_id`, `run_metadata`, the schedule occurrence join (`agent_task_schedule_occurrences.batch_run_id`, `active_batch_run_id` on schedules), and run-level `trigger` provenance (`source`/`actor`/`hostname`/`entrypoint`/`ci_*`). The dashboard's run list already shows a Trigger column and a Batch column — the raw material for labeling exists.

## Relation to the compare flow

`task-run-history.tsx` allows comparing exactly two runs **from different `batch_run_id`s** ("comparing a batch to itself is nonsensical"). Since one run per task per batch, this constraint is literally "compare two different iterations" — the iteration notion makes it legible ("iter 2 vs iter 3") instead of opaque batch ids, and same-iteration pairs cannot arise for one task today.

## What this leaves for the iteration-model decision

All three presentation-relevant notions (task-level ordinal, config-grouped ordinal, suite-level pass number) are derivable without schema changes; the decision is which to surface, whether one becomes a first-class `AgentTaskRunSummary` field (stable, API-visible, needs a small backend change) or stays presentation-derived, and whether a derived status (failed-then-passed) is worth adding alongside.
