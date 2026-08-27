# Task detail iteration structure: what apo's run data supports today

> Wayfinder asset for [Map what iteration structure apo's run data supports today](https://github.com/samikuikka/apo/issues/168), on the map [Make the task detail page honor evidence-view scope and iterations](https://github.com/samikuikka/apo/issues/165). Researched 2026-08-27. Facts only — the iteration-model decision lives on [Decide the iteration model for task run history](https://github.com/samikuikka/apo/issues/170).

## Verdict

**"Iteration" is not stored anywhere, but a per-task attempt number is derivable today with zero schema changes** — because apo's structural invariant is *one run per task per batch*: re-executing a task always creates a new batch, so a task's N runs live in N distinct batches, and "attempt N" is just the row number over the task's runs ordered by batch creation time.

`sequence_index` is **not** an iteration number and must not be presented as one. It is the *position of the task within its batch's task list* — a sequential-execution scheduling concept. Every real re-run in the live data sits in a single-task batch where `sequence_index` is hardcoded 0; a task run three times shows `0, 0, 0`.

## `sequence_index`: exact semantics

Column: `AgentTaskRunDB.sequence_index` (`backend/apo/models/db.py:477`), mirrored on `TaskExecutionAttemptDB.sequence_index` (`backend/apo/models/db.py:1600`). Model comment: *"ordered position within a sequential Batch. Lower index must be terminal before a higher-index Attempt becomes claim-eligible."*

Assignment per batch-creation path (all in `backend/apo/services/`):

| Path | Function | Assignment |
|---|---|---|
| Dashboard manual (non-pooled legacy) | `create_batch_run` (`agent_task_runner.py:76`) | **Never set** — every run keeps default `0` |
| Dashboard pooled + schedule "run now" | `create_pooled_batch_run` (`execution_queue.py:263`) | Re-indexes after creation: `enumerate()` over the batch's runs → `0..n-1` |
| Scheduler (automatic) | `agent_task_scheduler.py:288` → `create_pooled_batch_run` | Same as pooled |
| Source-owned dashboard/scheduler | `create_source_owned_batch_run` (`execution_queue.py:423`) | `enumerate()` over resolved task ids → `0..n-1` |
| CLI `apo run` (caller-executed) | `create_caller_batch_run` (`execution_queue.py:60`) | Hardcoded `0` — batch supports *exactly one task* |
| Dev/demo seeding | `dev_workspace.py:312`, `demo_workspace.py:254` | `enumerate()` |

The sequential claim rule that the comment references is enforced in `execution_leases.py:145-165`: within one batch, a higher-index attempt becomes claim-eligible only when all lower-index attempts are terminal. Its only read-side consumer is display order: `child_task_ids` (`agent_task_projection.py:168`) sorts a batch's children by `(sequence_index, id)`.

**It never counts re-executions.** A re-run is a new row in a new batch, where the index restarts. Its legitimate meaning is intra-batch task order ("task 3 of 12 in this pass").

## What `AgentTaskRunSummary` exposes

`backend/apo/models/schemas.py:665` — id, batch_run_id, task_id, task_path, adapter_name, status, pass_result, timestamps, trace link, primary_model, commit SHA, error/trace fields, cost/tokens/checks, corrected_tests, `run_configuration` (model/effort), and `trigger`. **No `sequence_index`, no attempt number, no per-task ordinal of any kind.**

`trigger` (`AgentTaskRunTrigger`, `schemas.py:467`) is parsed from the **batch's** `run_metadata` (`parse_trigger`, `agent_task_projection.py:49`) — so it is per-batch, shared by every run in the batch. Fields available: `source` (e.g. `cli`), `actor`, `hostname`, `user_agent`, `entrypoint`, `initiated_at`, CI fields (`ci_system`, `ci_run_id`, `ci_run_url`, `repository`, `branch`, `commit_sha`, `pr_number`), and `schedule_id`/`schedule_name`. In the live data every caller batch carries `{"trigger": {"source": "cli", "executor": "caller"}}`.

## Real-data shapes (main docker stack, `apo-backend-1:/app/data/apo.db`)

14 runs, 11 batches, 9 distinct tasks, queried 2026-08-27:

- **No task appears twice within any batch** (verified by `GROUP BY batch_run_id, task_id HAVING n > 1` → empty). This is also structurally guaranteed: every creation path enumerates a deduplicated task selection, and the caller path accepts exactly one task.
- `sequence_index` distribution: 11 runs at `0`; one run each at `1`, `2`, `3` — all four from the single multi-task batch (`agent-demo`, selection `all`, 4 tasks). Every single-task batch is `0`.
- Iteration histories that exist:
  - `docs-audit-stub`: **3 attempts** (passed → failed → passed) in 3 CLI batches on 2026-08-20, spaced 10 s and ~4 min apart.
  - `judge-flip-probe`: error → passed, 34 s apart (2026-08-26).
  - `markdown-deliverable`: error → passed, 16 s apart (2026-08-25).
  - `real-agent/documents/data-extraction`: 2 attempts with **different configs** — DeepSeek (demo batch) vs Gemini Flash Lite (CLI batch).
- Gaps the data exposes:
  - All caller-executed runs have `configured_model`/`configured_effort` **NULL** (adapter did not report config) — config-based grouping cannot assume config presence and needs an "unknown" bucket.
  - No scheduled batches exist yet (`schedule_id` trigger path is code-verified only, not data-verified).
  - The dev DB (`backend/data/apo.db`) holds zero agent-task runs; iteration histories live only in the docker stack volume.

## Derivable iteration notions, with data cost

1. **Per-task attempt number** — `ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY batch created_at [, started_at])`. Derivable today, no schema change; compute in the task-detail query (runs per task are few) or denormalize at write time if the Runs list needs it. Matches the data reality (every re-execution is a new batch) and maps cleanly onto the GitHub-Actions-style "attempt N of run" precedent from the drill-down survey.
2. **Batch-derived ordinal (`sequence_index`)** — already stored, but semantically *position of the task in the batch*, `0` for every single-task batch (where all real re-runs live). Presenting it as iteration would show a constant 0 for repeated runs and varying numbers across *different tasks* in one pass. Only honest use: intra-batch ordering.
3. **Batch pass grouping** — group a task's runs by `batch_run_id`, label with batch `created_at` + `trigger` (cli / schedule / ci). Zero cost; on a task detail page every run is already a distinct batch (one-run-per-task-per-batch invariant), so "group by pass" is trivially the run list itself. Answers "which pass, how was it triggered".
4. **Config-grouped passes** — group by `configured_model`/`configured_effort`. Works when config is reported; live data shows NULLs on all caller runs, so an explicit "unknown config" bucket is required.
5. **Suite-level pass number** — "batch N of the project" only means "Nth pass of the task set" for **set-level** batches (`selection_type` `all`/grep/folder). The live data is 10 single-task `caller-task` batches vs 1 set-level batch, so a suite ordinal that naively counts batches would misnumber passes whenever caller executions interleave. A suite-level iteration, if ever wanted on the tasks page, must count only set-level batches.

### Batch-origin signals (labeling "how this pass happened")

Beyond the run-level `trigger` (above), the batch table itself distinguishes origins: `selection_type` (set-level vs `caller-task`), `requested_by_user_id` (set for dashboard-initiated runs, NULL for CLI/caller), `run_metadata` (raw), and the schedule chain (`agent_task_schedule_occurrences.batch_run_id`, `active_batch_run_id` on schedules) for scheduled passes. In the live data: the one `all` batch is the only one with a requester; all ten `caller-task` batches have none.

## Relation to the compare flow

Compare is **batch-vs-batch**, not run-vs-run: the Runs page selects two *batches* (`runs-client.tsx:174-186` → `RunsCompareBar` → `/runs/compare?a=<batchId>&b=<batchId>`), and the compare model aligns the two batches' runs by `task_id` (`use-comparison.ts`). The alignment is unambiguous *because* a task appears at most once per batch.

Consequences for the iteration decision:

- Any notion that kept multiple attempts of one task **inside a single batch** would break compare's by-`task_id` alignment. The attempt-number notion (new batch per attempt, the status quo's shape) preserves it.
- "Latest attempt under config A vs latest under config B" maps onto compare's existing two-batch pick once attempts are numbered.
- A per-task iteration switcher on the detail page complements compare rather than conflicting with it — compare stays whole-batch.

## API-surface implications (input for the iteration-model decision)

- Exposing an attempt number is a **read-model + schema-file change only** (`AgentTaskRunSummary` + the task-runs query); no DB migration is needed for the computed variant.
- If `sequence_index` is ever exposed, name it by what it means (position in batch), never "iteration".
- `trigger` is already batch-scoped in the summary, so per-attempt "how was this pass triggered" labels are available without new ingestion.
