# Production-Ready Connected Executor Runtime

## Overview

Finish the incomplete runtime and protocol work behind `apo connect` so a real
dashboard or scheduled assignment can execute in the source-owning workspace,
emit its authenticated Trace, persist its full result, and terminate safely.
This is a completion and hardening spec for SPEC-161, not a new execution
model: the Control Plane still receives metadata and bounded results only, and
Task source remains on the connected machine.

## Dependencies

- canonical authenticated OTLP ingestion and Task Run trace claims.
- `walkWorkspaceForRevision` and canonical source manifests.
- durable Attempts, lease fencing, shared
  finalization, cancellation, and Caller Execution patterns.
- adapter-reported model/effort in the persisted Run result.
- explicit metadata-only Task Catalog publication and digest.
- protocol-v2 enrollment, source-owned Pool, local Executor state,
  source attestation, and the foreground `apo connect` command.
- dashboard and scheduled creation of source-owned
  Attempts targeted to one User.
- Existing code:
  - `packages/cli/src/commands/connect.ts`
  - `packages/cli/src/lib/connected-executor.ts`
  - `packages/cli/src/lib/executor-state.ts`
  - `packages/cli/src/lib/task-revision.ts`
  - `packages/cli/src/lib/git-provenance.ts`
  - `packages/cli/src/commands/task-run.ts`
  - `packages/sdk/src/agent-task/task-runtime.ts`
  - `backend/apo/routes/executor_protocol.py`
  - `backend/apo/routes/executor_protocol_v2.py`
  - `backend/apo/services/execution_leases.py`
  - `backend/apo/services/execution_finalization.py`

## Context

SPEC-161 established the correct product boundary, but its implementation
stopped at a protocol/control-loop skeleton. The current code must not be
treated as production complete:

- `connect.ts` submits an all-zero `content_sha256`, with zero file and byte
  counts, instead of hashing the current Task root.
- Task code is imported and executed inside the long-lived parent process.
  There is no Task-scoped child environment, secret separation, timeout, or
  cancellation termination.
- The assignment's `trace_endpoint`, Project, Task Run ID, environment, and
  Attempt JWT are not threaded into `runTaskDir`, so connected runs can silently
  execute without the Trace attached to the server-created Task Run.
- The result omits deliverables, transcript, and run configuration.
- Failure is incorrectly posted to the result endpoint.
- Protocol v2 does not register `/result` or `/failure`; any current connected
  execution reaches a 404 when it tries to finalize.
- The v2 claim route hand-writes leasing with fixed timeouts instead of using
  the shared capacity, queue-expiry, sequential-ordering, Pool-health, and lease
  fencing service.
- The CLI computes its catalog digest once at startup, ignores `Retry-After`,
  and does not have a real command-through-protocol scene test.

The green backend/CLI suites therefore prove the pieces that have tests, not a
complete connected Task execution. This spec closes those concrete gaps before
the legacy Bundled/Python executor retirement is allowed to begin.

### Locked product decisions

- `apo connect` remains a foreground command. No daemon, service installer,
  wake-up mechanism, CI integration, or always-on agent is introduced.
- One Task Attempt runs in one Node child process. This separates Project and
  Executor credentials from Task code and gives the parent a process it can
  terminate; it is not a hostile-code sandbox.
- Source code, absolute paths, environment values, provider credentials, and
  repository credentials never cross the Control Plane API.
- The child may inherit local provider/company environment values because the
  connected machine owns them. Apo-specific User, Project-key, enrollment, and
  Executor credentials are removed and replaced by the current scoped Attempt
  JWT.
- Protocol v2 is completed in place. Do not add protocol v3 or a second queue,
  lease, finalization, Task, Adapter, or trace model.
- The existing backend failure kinds are authoritative. Use `task_import`,
  `task_runtime`, `timeout`, `cancelled`, `executor_shutdown`, `result_invalid`,
  and `driver`; do not invent `task_timeout` or `task_resolution` in this spec.
- Default concurrency remains `4`; any positive safe integer is accepted. It
  is a machine limit, not a product quota.
- A transient connection failure never causes automatic Task re-execution.
  Attempt generation and lease state remain authoritative.

## Interface

### CLI child execution

Create a private child entrypoint and focused runtime helper:

```ts
// packages/cli/src/lib/local-task-child.ts
export interface ConnectedTaskChildInput {
  taskDir: string;
}

export type ConnectedTaskChildMessage =
  | {
      type: "result";
      summary: {
        taskId: string;
        pass: boolean;
        checks: unknown[];
        adapterName?: string;
        traceRunId?: string;
        deliverables?: Record<string, unknown>;
        transcript?: Record<string, unknown>;
        runConfiguration?: { model: string; effort?: string };
      };
    }
  | {
      type: "failure";
      failureKind: "task_import" | "task_runtime";
      errorMessage: string;
    };

export interface RunConnectedTaskChildOptions {
  taskDir: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  diagnosticTailBytes: number;
  signal: AbortSignal;
  outputPrefix: string;
}

export type ConnectedTaskChildOutcome =
  | {
      kind: "result";
      summary: Extract<ConnectedTaskChildMessage, { type: "result" }>["summary"];
      exitCode: number;
      stdoutTail: string;
      stderrTail: string;
    }
  | {
      kind: "failure";
      failureKind:
        | "task_import"
        | "task_runtime"
        | "timeout"
        | "cancelled"
        | "executor_shutdown";
      errorMessage: string;
      exitCode: number | null;
      stdoutTail: string;
      stderrTail: string;
    }
  | { kind: "lease_stale" };

export function runConnectedTaskChild(
  options: RunConnectedTaskChildOptions,
): Promise<ConnectedTaskChildOutcome>;
```

```ts
// packages/cli/src/internal/run-task-child.ts
// Private executable entrypoint. Receive ConnectedTaskChildInput over the
// Node IPC channel, call runTaskDir(taskDir), and send exactly one typed
// ConnectedTaskChildMessage before exiting.
```

Use Node's built-in child-process IPC channel. Do not put the Attempt JWT,
Executor credential, API key, provider keys, or other secret values in argv,
stdout, stderr, or temporary result files. The local Task directory may be sent
over IPC; it never enters an HTTP request.

### Pure child environment

Extract the current `.env` lookup behavior from `task-run.ts` into a reusable,
pure module:

```ts
// packages/cli/src/lib/task-env.ts
export interface ConnectedTaskScope {
  traceEndpoint: string; // origin/base URL; SDK appends canonical OTLP path
  project: string;
  taskRunId: string;
  environment: string;
  attemptJwt: string;
}

export function buildTaskChildEnvironment(options: {
  taskDir: string;
  cwd: string;
  inheritedEnv: NodeJS.ProcessEnv;
  scope: ConnectedTaskScope;
}): NodeJS.ProcessEnv;
```

The returned environment must:

1. Preserve the existing first-value-wins lookup order:
   `taskDir/.env`, `taskDir/../../.env`, `cwd/backend/.env`,
   `cwd/apps/example-service/.env`, then `cwd/.env`.
2. Let already-present inherited values win over `.env` values.
3. Never mutate `process.env`.
4. Remove `APO_API_KEY`, `APO_PUBLIC_KEY`, `APO_SECRET_KEY`,
   `APO_AUTH_TOKEN`, and every `APO_EXECUTOR_*` variable before applying the
   Task scope. Executor configuration belongs only to the parent process.
5. Set:

```text
AGENT_TASK_TRACE_ENDPOINT=<assignment trace_endpoint base URL>
AGENT_TASK_PROJECT=<assignment project>
AGENT_TASK_RUN_ID=<assignment task_run_id>
AGENT_TASK_ENVIRONMENT=<assignment environment>
AGENT_TASK_TRACE_REQUIRED=true
APO_AUTH_TOKEN=<assignment Attempt JWT>
```

Move local and Caller Execution to the shared environment parser where doing
so preserves their existing public behavior. Do not leave two drifting `.env`
parsers.

### Protocol-v2 client types

Replace `Record<string, unknown>` result submission with bounded types:

```ts
export interface AttemptResultRequest {
  completion_id: string;
  pass_result: boolean;
  adapter_name: string | null;
  trace_run_id: string | null;
  checks: Record<string, unknown>[] | null;
  transcript: Record<string, unknown> | null;
  deliverables: Record<string, unknown> | null;
  run_configuration: { model: string; effort?: string } | null;
  exit_code: number | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
  error_message: string | null;
}

export interface AttemptFailureRequest {
  completion_id: string;
  failure_kind:
    | "task_import"
    | "task_runtime"
    | "timeout"
    | "cancelled"
    | "executor_shutdown"
    | "result_invalid"
    | "driver";
  error_message: string | null;
  exit_code: number | null;
  stdout_tail: string | null;
  stderr_tail: string | null;
}

export interface AttemptHeartbeatResponse {
  cancel_requested: boolean;
  lease_expires_at: string;
}

export type ClaimWorkResult =
  | { kind: "assignment"; assignment: SourceOwnedAssignment }
  | { kind: "empty"; retryAfterMs: number }
  | {
      kind: "catalog_mismatch";
      projectCatalogDigest: string | null;
      retryAfterMs: number;
    };
```

Add separate `submitResult` and `submitFailure` functions. Both accept only the
Attempt JWT. Neither may fall back to a User/Project API key.

### Source attestation

Before `/start`, build the attestation from existing helpers:

```ts
const walked = walkWorkspaceForRevision({ rootDir: taskRoot });
const git = readGitProvenance(taskRoot);

const attestation: SourceAttestation = {
  source_type: "connected_worktree",
  repository_url: git.repositoryUrl,
  base_commit_sha: git.baseCommitSha,
  dirty: git.dirty,
  content_sha256: walked.contentSha256,
  task_root_label: basename(taskRoot),
  file_count: walked.manifest.summary.fileCount,
  uncompressed_size_bytes: walked.manifest.summary.uncompressedSizeBytes,
};
```

`task_root_label` is a basename/display label, never an absolute path. Apply
the same correction to Caller Execution, which currently sends the absolute
configured Task root.

### Backend claim service

Keep `claim_next_attempt(...)` as the stable protocol-v1 entry point. Refactor
its private atomic leasing core and add a source-owned wrapper rather than
maintaining a second hand-written claim implementation:

```python
def claim_next_source_owned_attempt(
    session: Session,
    *,
    executor: ExecutorDB,
) -> ClaimedAttempt | None:
    """Claim the oldest eligible source-owned Attempt for this Executor's User."""
```

The shared core must enforce all of these in the database-backed decision:

- Executor is enabled, unrevoked, protocol v2, and below persisted
  `max_concurrency`.
- Executor and Attempt belong to the same Project and canonical source-owned
  Pool.
- Pool is enabled, unarchived, and requires `source-owned-ts`.
- Attempt is queued, `assignment_kind="source_owned"`, targets the Executor's
  `enrolled_by_user_id`, and has not passed `queue_expires_at`.
- All lower `sequence_index` Attempts in the Batch are terminal.
- The conditional update still owns the atomic race and increments the lease
  generation exactly once.
- Client-reported `available_slots` may suppress a claim when zero, but can
  never grant capacity beyond persisted server state.

Use `ATTEMPT_LEASE_SECONDS`, the shared JWT creator, and the existing queue
reaper. Remove the fixed `300`, `3600`, and `7200` route-level lifecycle
constants where they duplicate shared authority.

## Acceptance Tests (RED-FIRST)

Write the missing tests before replacing the placeholders. At least one new
test must fail for each defect described in Context.

### CLI unit tests

1. **Real source attestation is submitted before start**
   - Setup: temporary Task root containing two ordinary files, an excluded
     `.env`, and Git provenance fixtures.
   - Action: execute one claimed assignment.
   - Expected: attestation digest matches `walkWorkspaceForRevision`; counts
     are non-zero and accurate; the URL is sanitized; label is not absolute;
     `/start` occurs only after attestation succeeds.

2. **Child environment carries only the scoped Apo credential**
   - Setup: inherited and `.env` values containing provider keys plus every
     Apo credential variable listed above.
   - Action: build the child environment.
   - Expected: provider/company values follow existing precedence; Project,
     Run, environment, endpoint, and Attempt JWT are exact; API key,
     public/secret key, enrollment token, and old auth token are absent.

3. **Environment construction does not mutate the parent**
   - Setup: snapshot `process.env` and several `.env` files.
   - Action: build two child environments concurrently.
   - Expected: parent values are unchanged and each child gets only its own
     Attempt scope.

4. **Successful child returns the full Run result**
   - Setup: child fixture returning checks, Trace ID, deliverables, transcript,
     and model/effort.
   - Action: run through `runConnectedTaskChild`.
   - Expected: one typed IPC result; result payload retains every field and is
     posted to `/result`, never `/failure`.

5. **Task failure uses the failure endpoint**
   - Setup: child fixture fails during import and another fails during runtime.
   - Action: execute each assignment.
   - Expected: bounded `task_import`/`task_runtime` payload goes to `/failure`;
     no false failed-check result is submitted.

6. **Timeout terminates the child**
   - Setup: child that ignores `SIGTERM` and assignment timeout short enough for
     a fake-timer test.
   - Action: timeout elapses.
   - Expected: parent sends `SIGTERM`, waits five seconds, sends `SIGKILL`, and
     reports `failure_kind="timeout"` exactly once.

7. **Cancellation terminates without retry**
   - Setup: heartbeat changes from `cancel_requested=false` to `true` while the
     child runs.
   - Action: next heartbeat arrives.
   - Expected: same TERM/grace/KILL path; `/failure` receives `cancelled`; no
     result is accepted afterward and no second assignment is created.

8. **Stale lease suppresses completion**
   - Setup: heartbeat returns 401/409 stale generation during execution.
   - Action: child later reports success.
   - Expected: child is terminated or its success is discarded; no User/API
     credential retry and no `/result` call occurs.

9. **Diagnostics stay bounded**
   - Setup: child writes output larger than `diagnostic_tail_bytes`.
   - Action: it succeeds and fails in separate cases.
   - Expected: terminal may stream prefixed output, but request tails contain
     only the allowed final bytes and serialized request respects
     `result_max_bytes`.

10. **Stable completion is idempotent**
    - Setup: first finalization response is lost after the server commits.
    - Action: client retries within the live lease.
    - Expected: the exact same completion ID and byte-equivalent body are sent;
      the Attempt finalizes once.

11. **Catalog changes stop new claims**
    - Setup: connected workspace initially matches, then one Task metadata file
      changes.
    - Action: next control heartbeat/poll runs.
    - Expected: current work may finish, local digest is recomputed, no new
      claims occur, and one `apo task publish` instruction is shown until the
      Project catalog matches again.

12. **Claim polling honors server timing**
    - Setup: `204 Retry-After: 7` and catalog-mismatch responses.
    - Action: run loop polls.
    - Expected: it waits the advertised interval without a tight loop and
      automatically becomes ready later without re-enrollment.

13. **First signal drains through bounded shutdown**
    - Setup: two running children and one queued slot.
    - Action: send SIGINT.
    - Expected: stop claims immediately, terminate active children through the
      graceful path, submit `executor_shutdown` while leases are current, and
      exit; second SIGINT forces local exit.

### Backend registered-route tests

Create `backend/tests/test_executor_protocol_v2.py` modeled on
`backend/tests/test_executor_protocol.py` and drive the router through the real
test application.

1. **Protocol-v2 complete success scene**
   - Setup: Project member, matching published catalog, v2 Executor, and one
     source-owned Attempt targeted to that member.
   - Action: heartbeat → claim → attestation → start → heartbeat → result.
   - Expected: each registered route succeeds; Attempt becomes succeeded;
     Task Run and Batch roll up; checks, Trace ID, deliverables, transcript,
     and run configuration persist.

2. **Protocol-v2 failure scene**
   - Setup: a claimed and started source-owned Attempt.
   - Action: post `task_runtime` to `/failure`.
   - Expected: shared finalizer marks Attempt failed and logical Run errored;
     the source-owned Schedule occurrence hooks still resolve normally.

3. **Claim preserves capacity and sequential order**
   - Setup: several Attempts, one Executor at capacity, and a Batch whose
     second Task is blocked by its first.
   - Action: call registered claim route concurrently/sequentially.
   - Expected: capacity is never exceeded, later Batch Tasks do not leapfrog,
     and oldest eligible work wins.

4. **Claim cannot cross User, Project, Pool, or assignment kind**
   - Setup: queued work differing in each boundary.
   - Action: one member's v2 Executor claims.
   - Expected: only its exact source-owned target is eligible; Bundled work and
     another member's work remain untouched.

5. **Queue expiry and Pool health suppress claims**
   - Setup: expired Attempt, disabled Pool, archived Pool, and healthy live
     Attempt.
   - Action: claim.
   - Expected: only healthy live work can be leased; reaper remains responsible
     for terminal expiry state.

6. **Attestation replay compares the normalized attestation**
   - Setup: one leased Attempt.
   - Action: submit exact attestation twice, then same digest with different
     provenance/count metadata.
   - Expected: exact replay is idempotent; different replay returns
     `409 attestation_conflict`; start without attestation remains 409.

7. **Lifecycle fencing matches protocol v1**
   - Setup: current and stale Attempt JWTs.
   - Action: call start, heartbeat, result, and failure aliases.
   - Expected: wrong Attempt or stale generation is rejected; exact completion
     replay is idempotent; changed replay conflicts.

8. **Assignment contains no source-owned secrets or execution recipe**
   - Setup: valid claim.
   - Action: inspect JSON response.
   - Expected: no path, source, Bundle, command, argv, environment values,
     User credential, or Executor credential; `trace_endpoint` is a base URL
     and does not already end in `/api/public/otel/v1/traces`.

### Real CLI scene test

Add `packages/cli/tests/connect-scene.test.ts`. Spawn the real
`packages/cli/src/main.ts connect` command against a local fake HTTP server and
an importable fixture Task root; do not call `executeAssignment` directly.

1. Publish fixture metadata separately in server state.
2. Let the CLI bootstrap/enroll or provide an existing mode-0600 state file.
3. Return one typed source-owned assignment.
4. Record every request and validate attestation → start → heartbeat → result
   ordering, scoped trace environment, full result, and absence of source/path/
   env fields in HTTP payloads.
5. Return no work, then send SIGINT and assert clean bounded exit.

This scene must fail against the pre-SPEC-164 implementation because the v2
result route is missing and the child/trace contract is not wired.

## Integration Points (WIRING — mandatory, concrete)

### Backend wiring

- `backend/apo/services/execution_leases.py`: extract a shared constrained
  atomic claim core; retain `claim_next_attempt` for protocol v1 and add
  `claim_next_source_owned_attempt` for protocol v2. Return renewed lease
  expiry from heartbeat state.
- `backend/apo/routes/executor_protocol.py`: keep all v1 request/response
  behavior stable while consuming any extracted shared lifecycle helpers.
- `backend/apo/routes/executor_protocol_v2.py`: replace manual leasing with the
  source-owned service, normalize the assignment base trace endpoint, and
  register fenced `/result` and `/failure` routes backed by the existing
  finalization services.
- If thin lifecycle request schemas/route adapters must be shared, create
  `backend/apo/routes/executor_attempt_lifecycle.py`; do not copy business
  finalization logic into both protocol routers.
- `backend/apo/api.py`: protocol-v2 router is already registered. The new scene
  test must use this real registration; do not add another router.

### CLI wiring

- `packages/cli/src/commands/connect.ts`: keep orchestration at the top and
  delegate attestation, child execution, heartbeat/cancellation, bounded
  finalization, and shutdown to focused helpers. Remove both placeholder
  comments and the in-process `runTaskDir` import.
- `packages/cli/src/lib/connected-executor.ts`: expose typed claim/lifecycle
  responses, `submitFailure`, Retry-After parsing, and structured HTTP errors.
- `packages/cli/src/lib/local-task-child.ts`: own process spawn, IPC, output
  tails, timeout, cancellation, and force-kill grace.
- `packages/cli/src/internal/run-task-child.ts`: import and call the existing
  SDK `runTaskDir`; no new public SDK execution API.
- `packages/cli/src/lib/task-env.ts`: own pure `.env` parsing and scoped child
  environment construction.
- `packages/cli/src/lib/executor-state.ts`: if server heartbeat/lease timing is
  persisted for reconnect, extend schema v1 with optional fields and safe
  defaults so existing state remains readable; never force re-enrollment only
  for this metadata.
- `packages/cli/src/commands/task-run.ts`: reuse the extracted env parser and
  correct the Caller attestation label without changing command flags.
- `packages/cli/src/main.ts`: `connect` is already registered and its public
  flags do not change. Verify help stays synchronized.

### SDK wiring

- No new SDK export is expected. The private child imports `runTaskDir` from
  `@apo/sdk/agent-task`, exactly like existing CLI paths.
- Do not modify the SDK to accept Control Plane paths, source, commands, or
  credentials. Fix endpoint normalization in the assignment/CLI boundary.

### Documentation wiring

- `docs/development.md`: document that Connected Executors use one Task child
  per Attempt, Task-scoped trace auth, real source attestation, and shared
  lease/finalization services.
- `specs/learnings.md`: record the implementation lesson that a protocol is
  not complete until its registered assignment-through-finalization scene
  passes; unit tests for enrollment/heartbeat alone did not prove execution.
- Do not rewrite the end-user getting-started flow or remove legacy Bundled
  documentation here; the retirement spec owns that cleanup.

## Behavior

### Ready and catalog state

1. Resolve normal login, Project, Task root, and local Executor state.
2. Discover bounded Task metadata and compute the digest without importing
   Task modules.
3. Enroll once if state is absent; otherwise reuse the same machine identity.
4. Recompute the local digest periodically. A missing/mismatched Project
   catalog keeps the Executor online but ineligible.
5. A matching digest plus free persisted capacity permits claim polling.
6. Never auto-publish. The only recovery instruction is explicit
   `apo task publish`.

### Assignment execution

1. Recompute local metadata immediately after claim and require equality with
   the assignment digest.
2. Resolve exactly one local Task by exact ID. Do not use a server path or
   fuzzy fallback.
3. Walk the configured Task root, read sanitized Git provenance, and submit
   the real source attestation.
4. Build the pure Task child environment.
5. Call `/start` immediately before spawning/importing customer Task code.
6. Spawn one child and heartbeat while it runs.
7. Stream prefixed human output while retaining only bounded diagnostic tails.
8. On success, submit the complete structured result. On operational failure,
   submit the typed failure. A failing Test is a successful execution with
   `pass_result=false`, not `task_runtime`.
9. Treat exact finalization replay as success. Never change the body for the
   same completion ID.

### Timeout, cancellation, lease loss, and shutdown

- Assignment timeout starts at `/start`, not at claim or source hashing.
- Timeout and cancellation send `SIGTERM`, allow five seconds, then `SIGKILL`.
- A successful Attempt heartbeat renews the client's known lease expiry from
  the response. During a transient partition the child may continue only
  while that known lease could still be live.
- A stale/revoked lease stops the child and suppresses normal result. Never
  retry with the User/API or Executor credential.
- First SIGINT/SIGTERM stops new claims and terminates active children through
  bounded finalization. Second SIGINT forces exit and lets server recovery be
  authoritative.
- No terminal condition automatically recreates or retries the Task Attempt.

### Bounded result handling

- Collect stdout/stderr tails incrementally; never buffer unbounded output.
- Serialize before submission and enforce `result_max_bytes`.
- If the normal result is too large, do not truncate structured checks or
  deliverables into misleading data. Submit bounded `result_invalid` failure
  explaining the limit.
- Error messages and diagnostic tails must not include credentials or a dump
  of the child environment.

## Data Flow

```text
dashboard Run or Schedule Occurrence
  -> backend creates source_owned Batch / Task Run / queued Attempt
  -> apo connect recomputes metadata digest and claims by User + Project + Pool
  -> CLI resolves exact local Task ID; server sends no path/source/env
  -> CLI hashes local Task root + sanitized Git provenance
  -> Attempt JWT submits source attestation
  -> /start fences the point before Task code executes
  -> parent creates scoped child env and spawns private Task child
  -> child runTaskDir emits authenticated OTLP with apo.task.run.id
  -> parent heartbeats, observes cancellation, and enforces timeout
  -> child sends structured summary over local IPC
  -> parent posts typed /result or /failure using Attempt JWT
  -> shared backend finalizer persists Run/Trace/Checks/Deliverables
  -> Batch and Schedule Occurrence roll up through existing hooks
```

No arrow carries repository files, Task source, absolute local paths,
environment values, provider credentials, or commands to the server.

## Implementation Details

Implement in this order so each correction is independently testable:

1. Write the registered protocol-v2 scene and prove the missing result route
   and manual claim behavior fail.
2. Refactor backend claim/lifecycle sharing; complete the v2 route aliases.
3. Extract and test pure Task child environment construction.
4. Add the private child entrypoint and process helper with result/failure,
   bounded output, timeout, cancellation, and shutdown tests.
5. Replace placeholder source attestation and in-process execution in
   `connect.ts`.
6. Add live catalog recomputation, structured claim results, Retry-After, and
   stable finalization retry.
7. Add the real CLI scene test through `main.ts`.
8. Update development documentation and learnings, then run full checks.

### Existing patterns to follow

- Real revision walking: `packages/cli/src/lib/task-revision.ts` and its tests.
- Sanitized provenance: `packages/cli/src/lib/git-provenance.ts`.
- Task result shape and trace env: `runCallerRecorded` in
  `packages/cli/src/commands/task-run.ts`—reuse the correct fields, but improve
  it by avoiding parent `process.env` mutation.
- Python child termination and bounded output semantics:
  `backend/apo/executor/drivers/subprocess.py` and
  `backend/tests/executor/test_subprocess_driver.py`; reproduce the contract in
  TypeScript without importing Python or adding a second product model.
- Registered route scene: `backend/tests/test_executor_protocol.py`.
- Shared state machine: `backend/apo/services/execution_leases.py` and
  `backend/apo/services/execution_finalization.py`.

## Quality Constraints

- Do not add npm or Python dependencies.
- Do not leave TODOs, placeholders, zero digests, fake provenance, or
  simplified execution paths.
- Do not use `any`; parse IPC and HTTP boundaries into explicit types.
- Do not execute Task source in the long-lived `apo connect` parent.
- Do not pass secrets on argv or log request headers/environment objects.
- Do not send source bytes, paths, commands, argv, cwd, environment values, or
  repository credentials to the Control Plane.
- Do not weaken protocol-v1 Bundled Executor behavior or its tests.
- Do not duplicate lease, finalization, trace-claim, digest, or `.env`
  precedence logic.
- Do not claim containers, VM isolation, or hostile-code sandboxing.
- Public `apo connect` flags and help remain unchanged.
- Keep public/orchestration functions at the top and focused helpers below;
  split files before they exceed repository size guidelines.
- All finalization retries must be idempotent and bounded.

## Database Changes

None. SPEC-161 through SPEC-163 already added the required Executor, Attempt,
Revision, targeting, and Schedule Occurrence fields. If implementation appears
to need a new table or credential column, stop and reuse the existing model.

## API Contract

All routes remain under `/v1/executor-protocol/v2`.

| Method | Path | Request | Response | Auth |
|---|---|---|---|---|
| POST | `/claims` | catalog digest + available slots | assignment, 204, or typed 409 | Executor credential |
| POST | `/attempts/{id}/source-attestation` | bounded attestation | Revision identity | Attempt JWT |
| POST | `/attempts/{id}/start` | driver + runtime versions | running state | Attempt JWT |
| POST | `/attempts/{id}/heartbeat` | phase | cancellation + renewed lease expiry | Attempt JWT |
| POST | `/attempts/{id}/result` | `AttemptResultRequest` | terminal Attempt state | Attempt JWT |
| POST | `/attempts/{id}/failure` | `AttemptFailureRequest` | terminal Attempt state | Attempt JWT |

### Claim responses

- `200`: exact `SourceOwnedAssignment` from SPEC-161.
- `204`: no eligible work, with a positive `Retry-After` header.
- `409 catalog_mismatch`: typed detail containing the Project digest and
  `Retry-After`; the Executor remains enrolled/online.

`trace_endpoint` is the externally reachable Apo origin/base consumed by
`createOtelAgentTaskTraceClient`, which appends
`/api/public/otel/v1/traces`. It must not contain that suffix twice.

### Lifecycle error responses

| Status | Kind | Meaning |
|---|---|---|
| 401 | invalid Attempt token | Never retry with another credential |
| 403 | wrong Attempt | Token is not valid for the path Attempt |
| 409 | `lease_stale` | Generation/ownership/state is no longer current |
| 409 | `completion_conflict` | Same Attempt completion changed on replay |
| 409 | `source_attestation_required` | `/start` called before attestation |
| 409 | `attestation_conflict` | Different attestation replay |
| 400 | invalid failure kind/body | Client bug; do not retry unchanged |

## Success Criteria

- [ ] The protocol-v2 registered scene performs claim through result and
      persists a complete source-owned Run.
- [ ] Protocol-v2 failure finalizes through the shared failure service.
- [ ] Claims use shared atomic capacity, TTL, Pool, targeting, and sequential
      eligibility rules; no route-level leasing implementation remains.
- [ ] `apo connect` submits the real workspace digest, file/byte counts, and
      sanitized provenance before `/start`.
- [ ] Each Attempt runs in a terminable child with pure scoped environment;
      Task code cannot inherit User, Project-key, enrollment, or Executor
      credentials through environment variables.
- [ ] Connected runs emit authenticated Traces linked to their pre-created Task
      Run and persist checks, deliverables, transcript, and model/effort.
- [ ] Timeout, cancellation, shutdown, stale lease, result-size, and transient
      finalization behavior have red-first tests and cannot double-execute.
- [ ] Catalog changes stop new claims and recover after explicit publication.
- [ ] The real `main.ts connect` scene passes and contains no source/path/env
      fields in Control Plane traffic.
- [ ] Existing protocol-v1 and dashboard/schedule tests remain green.
- [ ] `pnpm --filter @apo/cli test` passes.
- [ ] Focused backend tests and the full backend suite pass.
- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `cd backend && uv run basedpyright` passes with zero errors/warnings.
- [ ] `rg -n 'placeholder|simplified|TODO|FIXME'` over the touched Connected
      Executor runtime contains no incomplete implementation marker.

## Non-goals

- Removing protocol v1, Bundles, server-side dependency installation, or the
  Python Bundled Executor; the retirement-boundary spec owns that work.
- Background daemon/service installation, startup-at-boot, wake-on-demand, or
  exact machine selection.
- CI-provider orchestration or managed runners.
- Immutable local snapshots or requiring a clean Git worktree.
- Uploading Task source, repositories, commands, paths, or environment values.
- Hostile-code sandboxing, containers, VMs, seccomp, filesystem isolation, or
  running as another OS User.
- Automatic Task Catalog publication.
- Schedule ownership transfer, backlog, retries, or cadence changes.
- New dashboard UI, Schedule UI, Task/Adapter APIs, or Executor SDKs.
- End-user installation packaging or npm publication.
- Broad getting-started/legacy documentation cleanup.

## Log

- 2026-07-31: Spec created after auditing the implemented SPEC-161 through
  SPEC-163 chain and finding that the source-owned Control Plane was complete
  but the connected assignment runtime and v2 finalization path were not.
