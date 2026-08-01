# Retire Bundled Execution

## Overview

Make source-owned execution Apo's only executable Task runtime. Remove every
path that uploads, stores, downloads, extracts, installs, or executes customer
Task source on the Control Plane while preserving the existing installation,
source-free historical data, direct recorded CLI runs, and the protocol-v2
`apo connect` runtime.

This is an in-place product cutover, not a database reset or a compatibility
migration. Existing Users, Projects, memberships, credentials, producer keys,
Task Catalogs, Runs, Traces, and Deliverables remain; legacy execution becomes
permanently non-executable, and source-bearing objects are purged narrowly.

## Dependencies

- Client-Published Task Catalog. Non-demo Projects already publish
  bounded metadata instead of granting Apo repository access.
- Source-Owned Connected Executor. Provides protocol v2, member-owned
  enrollment, typed assignments, and per-Attempt source attestation.
- Dashboard Runs Through Connected Executors. Provides native manual
  dashboard dispatch without Pool or machine selection.
- Source-Owned Scheduled Delivery. Provides fixed-owner scheduled
  Occurrences delivered to that User's Connected Executors.
- Production-Ready Connected Executor Runtime. Completes real local
  execution and result/failure finalization through `apo connect`.
- Existing caller execution:
  `packages/cli/src/lib/caller-execution.ts`,
  `backend/apo/services/execution_queue.py::create_caller_batch_run`, and the
  Attempt lifecycle endpoints currently under `/v1/executor-protocol/v1`.
- Architecture decision: `docs/adr/0005-source-owned-task-execution.md`.

### Mandatory cutover evidence

Before this spec is merged/deployed, record evidence that the deployed
pre-cutover build completes both of these against the real Control Plane:

1. a dashboard-created Run claimed and completed by `apo connect`; and
2. a due or manually triggered source-owned Schedule Occurrence claimed and
   completed by `apo connect`.

Unit tests are not a substitute for this gate. The evidence may be recorded in
`specs/165-retire-bundled-execution.progress.txt` or the implementing PR. The
retirement implementation does not add a runtime feature flag or dual-mode
window after the gate passes.

## Context

The replacement runtime has two source-owning lifecycles:

```text
terminal / CI                         dashboard / schedule
-------------                         --------------------
apo task run                          apo connect
  -> one recorded Caller Attempt        -> persistent protocol-v2 Executor
  -> execute through runTaskDir          -> typed Task assignment
  -> source attestation                  -> execute through runTaskDir
  -> result + traces                     -> result + traces
```

The Control Plane coordinates identity, Task Catalog metadata, Attempts,
leases, cancellation, results, Traces, Tests, and Deliverables. It never needs
the repository, Task files, prompts, fixtures, lockfiles, dependency tree,
provider/company environment variables, or repository credentials.

The old runtime violates that boundary in several connected places:

- `backend/apo/execution/execution_bundle.py` creates and verifies source
  archives;
- `backend/apo/services/task_revisions.py::materialize_pooled_task_revision`
  stores them in the shared ArtifactStore;
- `/v1/executor-protocol/v1/enroll`, `/heartbeat`, `/claims`, and
  `/attempts/{id}/bundle` serve a Python Executor;
- `backend/apo/executor/` downloads, extracts, installs dependencies, and
  spawns customer Tasks;
- generic Pool APIs, dashboard Pool management, `--executor`, `--remote`,
  Task-level `execution`, Project execution defaults, and `apo batch create`
  expose multiple placement models;
- the Compose `executor` service and backend image contain Node, package
  managers, the SDK runner, and the example-service source only to support
  server execution;
- the Demo Workspace seeds itself by executing bundled example Tasks.

Some of the underlying control-plane tables remain useful. In particular,
`ExecutorPoolDB` remains as hidden internal routing storage for the canonical
`source-owned` Pool, while `ExecutorDB`, enrollment tokens, Attempts, leases,
and Attempt JWTs remain part of protocol v2. Do not delete shared machinery
merely because its historical name says Pool or Executor.

## Locked Product Boundary

### Keep

- `apo task run` as one-shot source-owned execution in the caller workspace.
- `apo connect` as foreground persistent execution for dashboard and Schedule
  assignments.
- Task Catalog publication through `apo task publish`.
- The canonical system-managed `source-owned` Pool as invisible database and
  queue plumbing.
- Protocol-v2 enrollment, heartbeat, claims, source attestation, start,
  heartbeat, result, failure, cancellation, lease recovery, and revocation.
- The caller create-and-claim API and its start/heartbeat/result/failure
  lifecycle.
- Existing Users, Projects, memberships, credentials, producer keys, Task
  Catalogs, Runs, Traces, Tests, Scores, Comments, and Deliverables.
- Best-effort read projection of historical Runs already in the database. No
  Bundle download or re-execution is available.

### Remove

- `execution: "backend"`, `execution: "local"`, and `execution: "auto"` from
  the SDK Task definition.
- CLI `--executor`, `--local`, and `--remote` placement flags.
- CLI `project config` / `default-execution` and stored execution-default
  behavior.
- CLI `batch create`. Keep read-only `batch list` and `batch show` as aliases
  for inspecting Runs.
- `ExecutionTarget.kind="pool"` from every write request.
- Generic Pool CRUD/default selection/manual enrollment APIs and UI.
- Protocol-v1 persistent Executor enrollment, claims, and Bundle transport.
- Execution Bundle construction, manifest verification, upload, download,
  cache, extraction, workspace preparation, and dependency installation.
- The Python Bundled Executor and subprocess driver.
- Bundled Pool bootstrap and installation-scoped Executor identity.
- Server-side Task runtime readiness and source/runtime cache requirements.
- Live Demo authoring/execution and the demo seed mutation endpoint.
- The Compose `executor` service and its state/bootstrap volumes.

### Preserve but ignore

Legacy relational columns/tables may remain where dropping them would add risk
without removing source bytes. They are read-only migration residue:

- `TaskRevisionDB.bundle_*` fields, used only to locate and then mark purged
  Bundle objects;
- historical `materialization="bundled"` Revision rows;
- historical `assignment_kind="bundled"` Attempts;
- historical Pool rows and Project default-Pool columns;
- historical bundled Schedule columns;
- legacy source columns on `ProjectTaskSourceDB`.

No new production code may create a bundled Revision, bundled Attempt, generic
Pool, or bundled Schedule. Do not add a fresh-database requirement merely to
avoid these nullable legacy columns.

## Interface

### CLI: one-shot Task execution

The canonical command is:

```text
apo task run <task-id | path> [--dir <path>] [--ci] [--no-record]
```

Retain any unrelated existing flags. Placement flags are absent:

```text
--executor   REMOVED
--local      REMOVED
--remote     REMOVED
```

Behavior:

1. With a configured backend, Project, and full-scope credential, execute in
   the current source-owning workspace through the caller create-and-claim
   protocol and record the Run.
2. With `--no-record`, execute in the current workspace without contacting the
   Control Plane.
3. With no configured Project/credential, execute unrecorded and print one
   explicit line saying the Run is not being recorded.
4. When recording is configured but the backend rejects or cannot accept the
   Run, exit `2`. Never silently downgrade a configured recorded Run to an
   unrecorded Run; the User may retry or choose `--no-record`.
5. Exit `0` for a passing Task, `1` for a completed failing Task, and `2` for
   configuration, transport, or execution errors.

Delete `packages/cli/src/lib/execution-mode.ts` and
`packages/cli/src/lib/execution-target.ts`. Simplify
`packages/cli/src/commands/task-run.ts` so its top-level flow chooses only
recorded caller vs explicit/necessary unrecorded execution.

Remove the `project config` `CommandEntry`, handler, tests, and help text. Stop
reading `default_execution` and `default_executor` from credentials; old keys
may remain harmlessly in an existing credentials file and must not affect
behavior.

Remove `batch create` from `packages/cli/src/main.ts` and delete
`packages/cli/src/commands/batch-create.ts`. Do not replace it with another
remote-dispatch command in this spec.

### SDK Task definition

Remove `TaskExecutionPreference` and the `execution` property from
`packages/sdk/src/agent-task/task/types.ts` and all public re-exports.

The Task definition returns to one meaning:

```ts
export interface TaskConfig<TInput = unknown> {
  adapter: Adapter<TInput>;
  deliverables?: readonly string[];
  // existing check/simulator/config fields remain
  // no execution placement field
}
```

Remove static `execution` extraction from
`packages/cli/src/lib/task-meta.ts`. A source file that still contains an
unknown `execution` property should fail TypeScript checking normally; the CLI
does not interpret it.

### Dashboard Run creation

`POST /v1/agent-task-batch-runs` becomes source-owned by definition.

Request:

```json
{
  "project": "prj_123",
  "task_ids": ["support/answer-ticket", "support/check-policy"],
  "environment": "default",
  "run_metadata": {
    "trigger": { "source": "dashboard" }
  }
}
```

The request model contains only:

```python
class CreateAgentTaskBatchRunRequest(SQLModel):
    model_config = {"extra": "forbid"}
    project: str
    task_ids: list[str]
    environment: str = "default"
    run_metadata: dict[str, object] | None = None
```

`selection_type`, `task_paths`, `task_root`, `grep`, and `execution_target` are
not accepted on this write endpoint. The authenticated User is always
`requested_by_user_id` and `target_user_id`; neither may appear in the body.

Response remains `201 AgentTaskBatchRunDetail`. Error behavior remains:

| Status | Kind | When |
|---|---|---|
| 401 | normal auth detail | No authenticated User can own execution |
| 403/404 | normal Project authorization | User lacks Project access |
| 409 | `task_catalog_missing` | Project has no published Task Catalog |
| 409 | `task_not_in_catalog` | Any exact Task ID is absent |
| 422 | `source_owned_selection_invalid` | Empty/duplicate/invalid Task IDs or extra legacy fields |

Historical response projection continues returning a legacy Pool target when
an old Run already stores one. That type is read-only: it must not be accepted
by any create or update schema.

### Direct caller execution

Keep:

```text
POST /v1/agent-task-batch-runs/caller
POST /v1/executor-protocol/v1/attempts/{attempt_id}/start
POST /v1/executor-protocol/v1/attempts/{attempt_id}/heartbeat
POST /v1/executor-protocol/v1/attempts/{attempt_id}/result
POST /v1/executor-protocol/v1/attempts/{attempt_id}/failure
```

Remove from protocol v1:

```text
POST /v1/executor-protocol/v1/enroll
POST /v1/executor-protocol/v1/heartbeat
POST /v1/executor-protocol/v1/claims
GET  /v1/executor-protocol/v1/attempts/{attempt_id}/bundle
```

Physically split or rename `backend/apo/routes/executor_protocol.py` to a
caller-focused module. Keeping the v1 URL prefix is intentional compatibility
for the current CLI; keeping persistent v1 Executor endpoints is not.

Remove the older `/agent-task-batch-runs/external` prepare/report flow and its
`/agent-task-runs/{id}/result` endpoint once `apo task run` uses only the caller
create-and-claim path.

### Connected Environments API

Retain protocol v2 unchanged except for removing comments/unions that describe
it as parallel to bundled execution:

```text
POST /v1/executor-protocol/v2/enroll
POST /v1/executor-protocol/v2/heartbeat
POST /v1/executor-protocol/v2/claims
POST /v1/executor-protocol/v2/attempts/{id}/source-attestation
POST /v1/executor-protocol/v2/attempts/{id}/start
POST /v1/executor-protocol/v2/attempts/{id}/heartbeat
POST /v1/executor-protocol/v2/attempts/{id}/result
POST /v1/executor-protocol/v2/attempts/{id}/failure
```

Replace generic Pool management with the focused surface below. Use these
exact Connected Environment paths; do not preserve generic Pool paths as
aliases:

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/v1/projects/{project}/connected-executor-bootstrap` | Mint one-use bootstrap for the current member | Project member |
| GET | `/v1/projects/{project}/connected-executor-status` | Current User aggregate status | Project member |
| GET | `/v1/projects/{project}/connected-executors` | List source-owned Executors | Member sees own; admin/owner may see all |
| POST | `/v1/projects/{project}/connected-executors/{id}/rename` | Rename an allowed Executor | Owner or Project admin |
| POST | `/v1/projects/{project}/connected-executors/{id}/revoke` | Revoke credential and active leases | Owner or Project admin |

Delete generic endpoints for Pool list/create/patch/archive/default selection,
manual Pool enrollment tokens, and container enrollment commands. The canonical
`source-owned` Pool is created internally by
`ensure_source_owned_pool()` and never serialized to the browser.

### Schedule API

Every new Schedule is source-owned. `selection` is required and Pool/path
fields are absent from create/update requests.

```python
class CreateAgentTaskScheduleRequest(SQLModel):
    model_config = {"extra": "forbid"}
    project: str
    name: str
    selection: ScheduleSelection
    environment: str = "default"
    cadence_type: str = "daily"
    timezone: str = "UTC"
    hour: int = 9
    minute: int = 0
    day_of_week: int | None = None
    day_of_month: int | None = None
    min_interval_days: float = 1.0
    max_interval_days: float = 30.0
    enabled: bool = True
    run_metadata: dict[str, object] | None = None

class UpdateAgentTaskScheduleRequest(SQLModel):
    model_config = {"extra": "forbid"}
    name: str | None = None
    selection: ScheduleSelection | None = None
    environment: str | None = None
    cadence_type: str | None = None
    timezone: str | None = None
    hour: int | None = None
    minute: int | None = None
    day_of_week: int | None = None
    day_of_month: int | None = None
    min_interval_days: float | None = None
    max_interval_days: float | None = None
    enabled: bool | None = None
    run_metadata: dict[str, object] | None = None
```

Reuse SPEC-163's exact discriminated `ScheduleSelection` validation and fixed
Execution Owner rules. Remove every bundled branch from create, update,
trigger-now, scheduler delivery, and serializers. Legacy bundled Schedule rows
remain disabled in the database and are omitted from active Schedule list/detail
queries; direct access may return `404`.

### Runtime configuration

`GET /v1/system/runtime-config` reports:

```ts
interface RuntimeConfig {
  backend_url: string;
  frontend_url: string;
  public_url: string;
  database: DatabaseDescriptor;
  artifact_store: ArtifactStoreDescriptor;
  task_execution_mode: "source_owned";
  scheduler_enabled: boolean;
  deployment_profile: DeploymentProfile;
  supported_topology: "single-node";
}
```

Remove `task_source_cache_dir`, `max_concurrent_batches`, and
`trusted_task_sources_only` if they no longer describe active operator knobs.
Remove `/v1/system/task-runtime`; the Control Plane does not need Node or a Task
runner. Readiness continues to check the database, auth secret, and shared
ArtifactStore because Deliverables still use the store. It no longer checks a
Task-source cache or server Task runtime.

### Task Catalog

Remove the misleading `execution_mode: "caller" | "bundled_demo"` field from
the Task Catalog response and TypeScript types. The catalog describes bounded
Task metadata, not placement. Dashboard and Schedule writes are source-owned;
`apo task run` is caller-owned; the Demo Catalog is read-only fixture data.

## Demo Workspace

The Demo Workspace remains a world-readable, mutation-protected Project, but
it becomes shipped data rather than executable source.

Add a versioned fixture such as:

```text
backend/apo/data/demo-workspace-v1.json
```

The fixture contains only public synthetic data:

- bounded Task Catalog metadata;
- one or more completed Batch/Task Runs;
- representative grouped Tests/check results;
- linked Trace/observation rows with token usage and cost examples;
- one source-free inline text or JSON Deliverable rendered by the existing
  Deliverables panel.

It contains no API key, producer key, password hash, repository URL, absolute
path, environment variable, provider credential, encrypted token, Bundle,
lockfile, package manifest, or executable Task source.

Implement an idempotent importer in
`backend/apo/services/demo_fixture.py`, called by the read-only helpers in
`backend/apo/services/demo_workspace.py`, with a fixed fixture version and
fixed row IDs. Startup:

1. ensures the `demo` Project exists;
2. ensures its read-only Task Catalog/inventory exists;
3. inserts fixture rows only when the version sentinel is absent;
4. never executes a Task, starts an Executor, contacts a model/provider, or
   emits network traffic;
5. leaves unrelated existing demo rows alone unless deleting them is required
   for a fixed-ID collision.

Remove `POST /v1/demo/seed`, `DEMO_AUTHORING_ENABLED`, live demo scheduling,
`seed_demo_workspace()`, and all imports of `create_pooled_batch_run` from demo
code. Keep `GET /v1/demo/status`; it reports the fixture version, `seeded`, and
`read_only: true`.

The fixture should omit executable Schedule rows. The Demo can show schedule
concepts in documentation; it does not need a special live Executor to make a
Schedule screen appear populated.

## Legacy Source-Byte Purge

Add `backend/apo/services/execution_retirement.py` with two idempotent startup
operations. Call them in `backend/apo/api.py::lifespan` after `init_db()` and
before demo import, scheduler startup, or lease recovery.

### 1. Fence legacy execution state

`retire_legacy_execution_rows(session, now)` must:

- disable legacy `execution_kind="bundled"` Schedules, clear `next_run_at`,
  clear active pointers when safe, and set
  `disabled_reason="bundled_execution_retired"`;
- terminalize queued/leased/running `assignment_kind="bundled"` Attempts as
  cancelled with `failure_kind="execution_retired"`, clear leases, and set a
  completion time;
- roll the linked pending/running Task Runs and Batches into an honest terminal
  error/cancelled state so no scheduler/reaper treats them as active;
- revoke non-source-owned persistent Executors and outstanding legacy
  enrollment tokens;
- disable/archive non-system legacy Pools;
- clear `ProjectDB.default_executor_pool_id` when it targets a legacy Pool;
- preserve protocol-v2 source-owned Executors, the canonical system-managed
  `source-owned` Pool, caller Attempts, source-owned Attempts, and source-owned
  Schedules;
- commit atomically and be a no-op on every later startup.

Do not delete Users, Projects, memberships, credentials, producer keys,
Catalogs, historical Runs, Traces, Tests, or Deliverables.

### 2. Purge Control Plane Bundle objects

`purge_legacy_bundle_objects(session)` must:

1. select only `TaskRevisionDB` rows whose `bundle_storage_key` is non-null;
2. resolve the exact recorded ArtifactStore backend for each row;
3. idempotently delete that one object key;
4. only after successful deletion, clear
   `bundle_storage_backend`, `bundle_storage_key`, `bundle_sha256`, and
   `bundle_size_bytes` on that row;
5. commit progress in bounded batches so a restart resumes safely;
6. treat an already-missing object as success;
7. fail startup with an actionable error if an object backend cannot be loaded
   or deletion fails for any other reason.

Never delete an ArtifactStore directory, prefix, bucket, or arbitrary sibling.
Deliverable objects share the same store and must remain byte-for-byte intact.
A crash after object deletion but before clearing the row must be safe: the next
startup repeats the idempotent delete and completes the row update.

Historical bundled Revision rows may remain with source-free metadata and null
Bundle fields. No route may download or re-materialize them.

### Host volumes outside the Control Plane store

The old `task_source_cache`, `apo_executor_state`, and
`apo_executor_bootstrap` Docker volumes are not mounted by the new stack and
cannot be safely guessed from inside the backend because Compose prefixes their
names. Add a cutover section to self-hosting documentation that instructs the
operator to:

1. stop/remove the old `executor` container;
2. list volumes for the exact Compose project;
3. inspect the exact three legacy volume names;
4. remove only those confirmed volumes;
5. start the new stack with `--remove-orphans`.

Never recommend `docker volume prune`, a wildcard deletion, or removal of the
database/artifact volume. Explicitly state that `apo_db` (or the configured
database and ArtifactStore) must remain.

## Data Flow

### Dashboard Run

```text
Tasks page
  -> POST /v1/agent-task-batch-runs {project, task_ids, ...}
  -> authenticate member and derive target User
  -> create source-owned Batch + Task Runs + Attempts
  -> apo connect claims only matching User/Project/catalog work
  -> CLI attests local source metadata (no bytes)
  -> CLI runs local Task through runTaskDir
  -> Attempt-scoped trace/result submission
  -> dashboard reads normal Run/Trace/Test/Deliverable projections
```

### Scheduled Run

```text
due source-owned Schedule
  -> idempotent Occurrence
  -> source-owned Batch targeting fixed Execution Owner
  -> owner's apo connect claims matching work
  -> same attestation/local execution/finalization path as dashboard Run
```

### Terminal Run

```text
apo task run
  -> discover exact local Task
  -> caller create-and-claim + attestation
  -> runTaskDir in caller process
  -> v1 caller-only start/heartbeat/result|failure
  -> normal Run/Trace/Test/Deliverable projection
```

At no point does the Control Plane request or receive Task source bytes.

## Implementation Details

### Files to delete

Delete these files/directories when no preserved import remains:

```text
backend/apo/executor/
backend/apo/execution/execution_bundle.py
backend/apo/execution/task_revision_manifest.py
backend/apo/services/bundled_executor.py
backend/apo/services/task_dependency_installer.py
backend/apo/services/agent_task_runtime.py
packages/cli/src/lib/execution-mode.ts
packages/cli/src/lib/execution-target.ts
packages/cli/src/commands/project-config.ts
packages/cli/src/commands/batch-create.ts
apps/dashboard/src/components/executor-pool-select.tsx
apps/dashboard/src/app/settings/executors/create-pool-dialog.tsx
apps/dashboard/src/app/settings/executors/edit-pool-dialog.tsx
apps/dashboard/src/app/settings/executors/enrollment-dialog.tsx
apps/dashboard/src/app/settings/executors/pool-list.tsx
```

Also delete their focused tests and replace them with source-owned-only tests;
do not keep production modules solely to keep legacy tests green.

### Backend files to modify

```text
backend/apo/api.py
  Remove bundled bootstrap and generic Pool/v1-persistent router wiring.
  Run execution retirement before scheduler/reaper startup.
  Import the pre-recorded Demo fixture idempotently.

backend/apo/models/db.py
  Keep shared tables and narrowly required legacy columns for in-place cleanup.
  Update comments/defaults so new ORM rows cannot default to "bundled".

backend/apo/models/execution.py
  Make source-owned/caller the only writable assignment contracts.
  Preserve a private/read-only parser for historical Pool projections only if
  the existing Run detail needs it.

backend/apo/models/schemas.py
  Narrow Batch and Schedule write schemas; remove external execution schemas
  and Task Catalog execution_mode.

backend/apo/routes/agent_task_runs.py
  Make normal Batch creation unconditionally source-owned.
  Keep caller create-and-claim and Run reads; remove pooled/external writes.

backend/apo/routes/agent_task_schedules.py
  Remove every bundled create/update/trigger branch and legacy Pool fields.
  Query only source-owned Schedules as active product records.

backend/apo/routes/executor_protocol.py
  Replace with a caller-only Attempt lifecycle router at the same v1 URLs.

backend/apo/routes/executor_protocol_v2.py
  Keep the production connected runtime; remove bundled comparison language.

backend/apo/routes/executor_pools.py
  Replace/split into focused Connected Environment bootstrap/status/list/
  rename/revoke routes. Delete generic Pool CRUD and manual enrollment.

backend/apo/services/execution_queue.py
  Keep caller and source-owned creation. Delete Pool resolution and pooled
  Bundle creation.

backend/apo/services/execution_leases.py
  Delete generic bundled claim logic. Keep source-owned claim, shared Attempt
  lifecycle, cancellation, and recovery.

backend/apo/services/task_revisions.py
  Keep attested Revision creation/read summary. Delete Bundle materialization,
  download helpers, and normal project/batch Bundle cleanup; the retirement
  service owns the one-time strict purge.

backend/apo/services/agent_task_runner.py
backend/apo/services/agent_task_run_service.py
  Move the still-shared result/status finalizers into
  agent_task_run_service.py. Delete filesystem selection, server source
  resolution, and external prepare/report code; remove the runner module if it
  becomes empty.

backend/apo/services/runtime_config.py
backend/apo/routes/system_runtime.py
  Remove server Task runtime/cache checks and report source_owned execution.

backend/apo/services/demo_workspace.py
backend/apo/routes/demo.py
  Replace live authoring with deterministic fixture import/status.
```

Remove `project_task_source_sync.py`, `paths.py` demo-root behavior, and
server-side discovery helpers only after verifying no non-demo publication or
Demo fixture import uses them. Preserve local discovery in the TypeScript CLI;
that is the source-owning boundary.

### Frontend files to modify

```text
apps/dashboard/src/lib/agent-task-api.ts
  Remove writable Pool targets and bundled Schedule fields.

apps/dashboard/src/lib/executor-api.ts
  Replace Pool CRUD types/helpers with Connected Environment list/status/
  rename/revoke helpers.

apps/dashboard/src/app/settings/executors/page.tsx
apps/dashboard/src/app/settings/executors/executors-client.tsx
apps/dashboard/src/app/settings/executors/executor-list.tsx
  Render "Connected environments" only. Explain that each member runs
  `apo connect` in the Task workspace. Preserve status, owner, rename, and
  revoke actions; show no Pool/default/token/container controls.

apps/dashboard/src/app/project/[projectId]/tasks/tasks-client.tsx
  Send the narrowed source-owned request without execution_target.

apps/dashboard/src/app/project/[projectId]/schedules/**
  Send/handle only typed catalog selections and source-owned ownership.

apps/dashboard/src/components/agent-task-execution/**
  Preserve source-owned and caller language. Historical unknown/legacy Runs
  may use neutral "retired execution" language; never offer retry/download.

apps/dashboard/src/lib/system-api.ts
apps/dashboard/src/components/system-runtime-panel.tsx
  Remove Task runtime/cache/Pool topology and display source-owned execution.
```

Read `docs/design.md` before changing these UI files. Prefer renaming the
settings route label to **Connected environments** even if the physical route
remains `/settings/executors` to avoid an unnecessary URL migration.

### CLI and SDK files to modify

```text
packages/cli/src/commands/task-run.ts
packages/cli/src/lib/task-meta.ts
packages/cli/src/lib/config.ts
packages/cli/src/lib/credentials.ts
packages/cli/src/main.ts
packages/sdk/src/agent-task/task/types.ts
packages/sdk/src/agent-task/task/defineTask.ts
packages/sdk/src/agent-task/public.ts
packages/sdk/src/agent-task/task/index.ts
```

Keep `packages/cli/src/lib/caller-execution.ts`,
`packages/cli/src/lib/connected-executor.ts`, and `runTaskDir`. These are the
replacement runtime, not legacy adapters.

Every CLI command deletion/change must update the `commands` record in
`packages/cli/src/main.ts` and its help snapshots/tests in the same change.

### Deployment files to modify

```text
docker-compose.yml
  Remove executor service, bundled env vars, executor state/bootstrap volumes,
  task-source cache mount, and backend dependency on those resources.

backend/Dockerfile
  Remove the Node builder, SDK agent-task runtime, Node/npm/pnpm/yarn/uv/Poetry,
  Git, example-service Task source, example agent source, demo npm install,
  executor/bootstrap mountpoints, and AGENT_TASK_RUNTIME_DIR/DEMO_TASK_ROOT.
  Retain only packages actually required by the FastAPI Control Plane and
  healthcheck.

backend/package.json
package.json
  Remove the Python executor dev script/process. Keep the dashboard/backend/
  example-service development processes that remain intentional.
```

Do not remove Node from the CLI/SDK development toolchain. Only the backend
runtime image stops carrying a Task executor.

### Documentation to update

Update active architecture, development, CLI, schedule, and self-hosting docs,
including at least:

```text
docs/adr/0005-source-owned-task-execution.md
docs/architecture.md
docs/development.md
docs/self-hosted-alpha.md
apps/docs/src/content/docs/quickstart.mdx
apps/docs/src/content/docs/cli/task-run.mdx
apps/docs/src/content/docs/cli/batch.mdx
apps/docs/src/content/docs/reference/schedule-schema.md
apps/docs/src/content/docs/reference/configuration.md
apps/docs/src/content/docs/self-hosting/topology.md
apps/docs/src/content/docs/self-hosting/configuration.md
```

Delete or rewrite pages whose main subject no longer exists. Search all active
docs for Bundled Executor, Pool selection, `--remote`, `--executor`,
`execution: "backend"`, task source cache, server dependency installation,
and live demo seeding. Historical specs may retain those terms.

## Integration Points (WIRING)

### Backend wiring

- `backend/apo/api.py` registers the caller-only protocol router, protocol v2,
  focused Connected Environment routes, and no generic Pool/bundle route.
- The lifespan calls execution retirement before scheduler/reaper startup.
- Normal Batch creation calls `create_source_owned_batch_run` directly.
- Schedule delivery calls the SPEC-163 source-owned Occurrence path only.
- Caller execution continues through `create_caller_batch_run` and shared
  Attempt finalization.
- Protocol v2 continues through `claim_next_source_owned_attempt` and
  source-attestation finalization.
- Demo import runs at startup and performs database inserts only.

### Frontend wiring

- The real Tasks page sends the narrowed Batch request.
- The real Schedules pages create/edit only source-owned Schedules.
- Settings navigation reaches the Connected Environments page and no Pool
  management component is imported anywhere.
- Run detail still renders caller/source-owned Attempts and neutral historical
  records without offering source retrieval.
- System settings render the updated runtime descriptor.

### CLI/SDK wiring

- `packages/cli/src/main.ts` exports help for `task run`, `task publish`, and
  `connect` with no retired placement command/flag.
- `task-run.ts` imports caller execution directly and no execution resolver.
- Public SDK entry points no longer export `TaskExecutionPreference`.
- `apo connect` continues importing the real SDK `runTaskDir` path used by
  SPEC-164.

### Deployment wiring

- `docker compose config --services` contains no `executor`.
- Backend readiness succeeds without Node, Task source/cache, or executor
  volumes.
- The Control Plane ArtifactStore remains configured for Deliverables and for
  the one-time Bundle purge.

## Quality Constraints

- Do not add a compatibility flag, hidden Bundled mode, or second executor.
- Do not reset or replace the database.
- Do not delete the database/artifact volume or any Deliverable object.
- Do not accept source, repository, path, command, environment, or secret data
  in source-owned assignment APIs.
- Do not expose the internal source-owned Pool in dashboard requests or UI.
- Do not silently convert a legacy Pool write request into source-owned work;
  reject it through `extra="forbid"`/`422`.
- Do not silently downgrade configured recorded CLI execution to unrecorded.
- Do not retain Python executor files merely for historical tests.
- Do not add dependencies.
- New/modified Python must pass basedpyright with zero errors/warnings.
- TypeScript must not use `any` to bypass narrowed contracts.
- All buttons retain `type="button"`; all Connected Environment actions remain
  accessible and follow `docs/design.md`.
- Source-object cleanup must be idempotent, narrowly keyed, and fail closed.
- Logs may contain counts and opaque object-key prefixes, never source names,
  repository URLs, Task contents, credentials, or full secrets.

## Acceptance Tests (RED-FIRST)

Write the removal/contract tests first. At least one assertion in every new
test file must fail against the pre-SPEC-165 implementation.

### Backend unit tests

1. **Retirement preserves the installation**
   - Setup: Users, memberships, Project, full and producer keys, Catalog,
     caller/source-owned Runs, Trace, Test result, and Deliverable plus legacy
     bundled state.
   - Action: run `retire_legacy_execution_rows` twice.
   - Expected: identity/project/catalog/result data is unchanged; only legacy
     execution rows are fenced; second run changes nothing.

2. **Only bundled work is terminalized**
   - Setup: active caller, source-owned, and bundled Attempts plus source-owned
     and bundled Schedules.
   - Action: run retirement.
   - Expected: bundled Attempt/Schedule is terminal/disabled with stable
     retirement reasons; caller/source-owned rows remain active and claimable.

3. **Bundle objects are narrowly purged**
   - Setup: fake store with two revision Bundle keys, a Deliverable key, and a
     sibling sentinel.
   - Action: run Bundle purge twice.
   - Expected: only the two Bundle keys are deleted; corresponding DB storage
     fields are null; Deliverable/sentinel remain; second run is a no-op.

4. **Bundle purge resumes after failure**
   - Setup: store succeeds for one key and fails for the next.
   - Action: purge, restart with a healthy store, purge again.
   - Expected: first call fails startup after committing safe progress; second
     completes without broad deletion or duplicate side effects.

5. **Internal source-owned Pool survives**
   - Setup: canonical source-owned Pool, protocol-v2 Executor, Bundled Pool,
     installation Executor, and legacy token.
   - Action: retire legacy state.
   - Expected: canonical Pool/v2 Executor remain; legacy Pool/Executor/token
     cannot authenticate or claim.

6. **No production Bundle symbols**
   - Setup: scan production Python/TypeScript/Compose/Dockerfile sources.
   - Action: search removed modules, imports, endpoints, flags, and env vars.
   - Expected: no executable reference remains; an allowlist permits historical
     DB field names only in models, projections, and retirement cleanup.

### Backend registered-route scenes

7. **Dashboard creation is implicitly source-owned**
   - Setup: authenticated member and published two-Task Catalog.
   - Action: POST the narrowed body to the registered Batch route.
   - Expected: `201`; exact ordered Tasks; source-owned Attempts target the
     authenticated User; no Revision or Bundle storage write.

8. **Legacy Batch payload is rejected**
   - Setup: authenticated member and valid catalog.
   - Action: send `execution_target`, `task_paths`, `task_root`, or `grep`.
   - Expected: `422`; no Batch/Attempt/object is created.

9. **Caller execution remains end-to-end reachable**
   - Setup: published Task and valid caller attestation.
   - Action: caller create-and-claim, start, heartbeat, and result through the
     registered routes.
   - Expected: completed recorded Run with source-free attested Revision.

10. **Persistent protocol v1 is gone**
    - Setup: registered FastAPI application.
    - Action: call v1 enroll/heartbeat/claims/Bundle endpoints.
    - Expected: framework `404`; caller lifecycle endpoints still work.

11. **Protocol v2 still completes work**
    - Setup: the focused SPEC-164 real/fake-server scene plus registered backend
      route tests.
    - Action: enroll, heartbeat, claim, attest, start, heartbeat, result/failure.
    - Expected: unchanged source-owned completion and no source/path/env/secret
      in assignment payloads.

12. **Only focused Connected Environment management is registered**
    - Setup: member, admin, canonical Pool, several owned Executors.
    - Action: bootstrap/status/list/rename/revoke and call old Pool CRUD/token
      paths.
    - Expected: focused routes enforce ownership/roles; old routes return `404`;
      responses contain no Pool/default/container fields.

13. **Schedules are source-owned only**
    - Setup: authenticated Project admin and published Catalog.
    - Action: create, edit, trigger, and dispatch through registered routes.
    - Expected: fixed Execution Owner, typed selection, source-owned Attempt;
      any Pool/path/TTL payload receives `422`.

14. **Readiness has no server Task runtime dependency**
    - Setup: backend environment without Node, runtime bundle, Task-source
      cache, or executor volumes.
    - Action: call `/health/ready` and runtime config.
    - Expected: readiness depends only on active Control Plane prerequisites;
      execution mode is `source_owned`; `/v1/system/task-runtime` is `404`.

15. **Demo imports without execution**
    - Setup: empty database; monkeypatch subprocess, model/provider HTTP,
      Executor services, and Bundle storage writes to fail if called.
    - Action: run startup twice and browse Demo Tasks/Run/Trace endpoints.
    - Expected: deterministic fixture appears once, is read-only, and no
      forbidden execution/network path runs.

### CLI/SDK unit and scenes

16. **Task definition has no placement API**
    - Setup: SDK type test and public package entry import.
    - Action: compile a normal Task and an `execution: "backend"` Task.
    - Expected: normal Task compiles; retired property/export does not.

17. **Recorded Task Run uses caller execution by default**
    - Setup: real `main.ts task run` handler, configured Project/full key, and
      mocked caller lifecycle.
    - Action: run without placement flags.
    - Expected: caller create-and-claim is used; local Task runs once; result is
      reported; no Pool endpoint is contacted.

18. **Configured recording fails closed**
    - Setup: valid configured Project but unreachable/rejecting backend.
    - Action: run normally, then with `--no-record`.
    - Expected: normal exits `2` without executing; `--no-record` executes
      locally and clearly says it is unrecorded.

19. **Retired CLI surface is absent**
    - Setup: render global and command help through `main.ts`.
    - Action: inspect help and invoke retired commands/flags.
    - Expected: no `project config`, `batch create`, `--executor`, `--local`,
      `--remote`, default execution, or Pool language; unknown inputs fail
      normally.

20. **apo connect regression scene**
    - Setup: SPEC-164's real `main.ts connect` command-through-protocol scene.
    - Action: deliver one typed assignment.
    - Expected: Task executes in the child process and reports a terminal
      result with unchanged cancellation/heartbeat/source-attestation behavior.

### Dashboard scenes

21. **Tasks page runs without a Pool target**
    - Setup: render the real Tasks page with a published Catalog.
    - Action: select Tasks and Run.
    - Expected: request is the narrowed source-owned shape and connected-state
      guidance is rendered.

22. **Schedules page has no Pool controls**
    - Setup: render real create/edit Schedule pages.
    - Action: inspect fields and submit.
    - Expected: typed Task selection and cadence only; no Pool, path, Task root,
      queue TTL, or execution mode controls.

23. **Settings exposes Connected Environments only**
    - Setup: render the real settings page as member and admin.
    - Action: list/rename/revoke Executors.
    - Expected: correct actions and ownership; no Pool/default/enrollment Docker
      UI or source-bearing terminology.

24. **Historical Run is non-executable**
    - Setup: old bundled Run row with purged Bundle fields.
    - Action: open Runs list/detail.
    - Expected: page renders neutral `Retired execution` history and offers no
      Bundle download, retry, Pool mutation, or re-execution action.

25. **Demo is visibly read-only fixture data**
    - Setup: render real Demo Tasks and Run detail pages from fixture rows.
    - Action: browse available pages.
    - Expected: representative data renders and mutation/Run actions remain
      unavailable; no prompt suggests starting a demo Executor.

### Deployment tests

26. **Compose has no executor topology**
    - Setup: repository Compose file.
    - Action: render `docker compose config`.
    - Expected: no executor service, bootstrap/state/source-cache volume, or
      bundled environment variable; frontend/backend still wire correctly.

27. **Backend image contains no Task runtime**
    - Setup: inspect/build backend Dockerfile.
    - Action: assert removed stages/packages/copies/env are absent and run the
      built image readiness test.
    - Expected: backend starts without Node/package managers/Git/demo Task
      source and serves the pre-recorded Demo fixture.

28. **Upgrade instructions preserve the database**
    - Setup: read active self-hosting upgrade docs.
    - Action: follow the retirement checklist in a disposable Compose project.
    - Expected: exact three legacy volumes are removed; database/artifact data
      remains; new stack starts; Users/Projects/keys/Catalog remain.

## Database Changes

Do not drop the database or introduce a fresh-install requirement.

No schema change is required merely to retire behavior. Prefer an idempotent
startup data migration in `execution_retirement.py` over destructive table
rebuilds. If implementation needs a schema marker or a new
`disabled_reason`-compatible field, use the next schema version after current
v18 and support both SQLite and PostgreSQL; otherwise leave
`LATEST_SCHEMA_VERSION` unchanged.

Fresh rows must never depend on legacy defaults such as
`assignment_kind="bundled"` or `execution_kind="bundled"`. Set explicit
source-owned/caller values at every retained creation site and change safe ORM
defaults where possible without rebuilding existing tables.

## API Contract Summary

### Retained write endpoints

| Method | Path | Runtime |
|---|---|---|
| POST | `/v1/agent-task-batch-runs` | Dashboard source-owned |
| POST | `/v1/agent-task-batch-runs/caller` | One-shot recorded CLI |
| POST | `/v1/agent-task-schedules` | Source-owned Schedule |
| PATCH | `/v1/agent-task-schedules/{id}` | Source-owned Schedule |
| POST | `/v1/agent-task-schedules/{id}/trigger` | Source-owned Run Now |
| POST | `/v1/projects/{project}/connected-executor-bootstrap` | Member `apo connect` bootstrap |
| POST | `/v1/executor-protocol/v2/**` | Connected Executor lifecycle |
| POST | `/v1/executor-protocol/v1/attempts/{id}/**` | Caller Attempt lifecycle only |

### Removed endpoint families

| Family | Result after cutover |
|---|---|
| Persistent protocol-v1 enrollment/claim/Bundle | `404` |
| Generic Executor Pool CRUD/default/token | `404` |
| External prepare/report execution | `404` |
| Demo seed/authoring | `404` |
| Server Task runtime status | `404` |

Unknown legacy fields on retained write endpoints return `422`; they are never
silently ignored or converted.

## Success Criteria

- [ ] Real deployed dashboard and scheduled source-owned Runs passed before
      cutover.
- [ ] No production path creates, uploads, downloads, extracts, installs, or
      executes an Execution Bundle.
- [ ] No Python Bundled Executor, subprocess driver, server Task runtime, or
      dependency installer remains.
- [ ] `apo task run` records through caller execution by default and supports
      explicit `--no-record` only.
- [ ] `apo connect` completes dashboard and scheduled work unchanged.
- [ ] Dashboard/Schedule writes are source-owned without Pool selection.
- [ ] Generic Pool, execution-default, placement-flag, and remote Batch-create
      product surfaces are absent.
- [ ] Existing installation identity/configuration/result data is preserved.
- [ ] Active legacy work is permanently fenced before scheduler/reaper startup.
- [ ] Every source-bearing Bundle object is narrowly purged and its storage
      reference cleared; Deliverables are untouched.
- [ ] Self-hosting docs give exact, non-broad cleanup steps for old source/
      executor volumes and explicitly preserve the DB/artifact volume.
- [ ] Demo Workspace imports pre-recorded read-only data without code execution
      or network access.
- [ ] Backend image and Compose topology no longer contain a Task executor.
- [ ] Active docs consistently teach `apo task publish`, `apo task run`, and
      `apo connect` as the only Task workflow.
- [ ] `pnpm --filter @apo/cli test` passes.
- [ ] `pnpm --filter @apo/sdk test` passes.
- [ ] Relevant dashboard tests pass, including all real-page scenes.
- [ ] Relevant backend tests pass, including retirement, caller, protocol-v2,
      schedules, Demo, readiness, and object-purge scenes.
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm doctor`, and
      `pnpm react-doctor --verbose --scope changed` pass.
- [ ] `cd backend && uv run basedpyright` passes with zero errors/warnings.
- [ ] `docker compose config` and the backend container readiness smoke pass.

## Non-goals

- Migrating or converting legacy bundled Runs into source-owned Runs.
- Re-executing, downloading, or reproducing historical Bundles.
- Preserving queued/running legacy work through cutover.
- Resetting the database, recreating accounts, or rotating unrelated keys.
- CI-provider-specific orchestration; `apo task run` remains sufficient.
- A daemon/service installer for `apo connect`.
- Managed sandboxes, Kubernetes, autoscaling, remote wake-up, or hosted source
  execution.
- Uploading repositories, prompts, fixtures, dependency manifests, environment
  values, or secrets to the Control Plane.
- Dashboard model/effort overrides or arbitrary command execution.
- Removing the ArtifactStore; Deliverables still use it.
- A general schema-compaction migration for every legacy nullable column.

## Log

- 2026-07-31: Spec created from the resolved source-owned execution Wayfinder
  map and the locked in-place retirement boundary.
