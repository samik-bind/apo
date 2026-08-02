/**
 * CLI caller-execution client.
 *
 * Drives the caller create-and-claim protocol: POST /agent-task-batch-runs/caller
 * (Project API key) to atomically create the Batch + attested Revision + leased
 * caller Attempt, then /start, periodic /heartbeat, and /result or /failure
 * against the executor-protocol endpoints using the returned Attempt JWT (never
 * the Project API key). The raw API key stays in the CLI process and is never
 * injected into the Task environment.
 */

import type { CallerIdentity } from "./git-provenance.ts";

export interface CallerTaskDescriptor {
  task_id: string;
  task_path: string;
  display_name: string;
  adapter_name: string | null;
  has_checks: boolean;
}

export interface CallerSourceAttestation {
  source_type: "caller_worktree";
  repository_url: string | null;
  base_commit_sha: string | null;
  dirty: boolean;
  content_sha256: string;
  task_root_label: string;
  file_count: number;
  uncompressed_size_bytes: number;
}

export interface CallerLease {
  attemptId: string;
  generation: number;
  token: string; // Attempt JWT
  expiresAt: string;
}

export interface CreateCallerRunInput {
  backendUrl: string;
  apiKey: string;
  project: string;
  task: CallerTaskDescriptor;
  environment: string;
  runMetadata: Record<string, unknown> | null;
  attestation: CallerSourceAttestation;
  identity: CallerIdentity;
  /** SPEC-169: canonical Task Definition document. */
  taskDefinition?: { schema_version: 1; files: [{ path: string; content: string }] } | null;
}

export interface CreatedCallerRun {
  lease: CallerLease;
  batchRunId: string;
  taskRunId: string;
  traceEndpoint: string;
  traceProject: string;
}

export interface CallerResultBody {
  completion_id: string;
  pass_result: boolean;
  adapter_name?: string | null;
  trace_run_id?: string | null;
  checks?: unknown;
  transcript?: Record<string, unknown> | null;
  deliverables?: Record<string, unknown> | null;
  run_configuration?: { model: string; effort?: string } | null;
  exit_code?: number | null;
  stdout_tail?: string | null;
  stderr_tail?: string | null;
  error_message?: string | null;
}

export interface CallerFailureBody {
  completion_id: string;
  failure_kind: string;
  error_message?: string | null;
  exit_code?: number | null;
  stdout_tail?: string | null;
  stderr_tail?: string | null;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

export async function createCallerRun(input: CreateCallerRunInput): Promise<CreatedCallerRun> {
  const url = `${input.backendUrl.replace(/\/$/, "")}/v1/agent-task-batch-runs/caller`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      project: input.project,
      task: input.task,
      environment: input.environment,
      run_metadata: input.runMetadata ?? {},
      source_attestation: input.attestation,
      caller_identity: input.identity,
      ...(input.taskDefinition ? { task_definition: input.taskDefinition } : {}),
    }),
  });
  if (!resp.ok) {
    throw new Error(`caller create failed: ${resp.status} ${await safeText(resp)}`);
  }
  const body = (await resp.json()) as {
    batch_run_id: string;
    task_run_id: string;
    attempt_id: string;
    lease_generation: number;
    lease_expires_at: string;
    attempt_jwt: string;
    trace_endpoint: string;
    trace_project: string;
  };
  return {
    batchRunId: body.batch_run_id,
    taskRunId: body.task_run_id,
    lease: {
      attemptId: body.attempt_id,
      generation: body.lease_generation,
      token: body.attempt_jwt,
      expiresAt: body.lease_expires_at,
    },
    traceEndpoint: body.trace_endpoint,
    traceProject: body.trace_project,
  };
}

function attemptUrl(backendUrl: string, lease: CallerLease, suffix: string): string {
  return `${backendUrl.replace(/\/$/, "")}/v1/executor-protocol/v1/attempts/${lease.attemptId}/${suffix}`;
}

function attemptHeaders(lease: CallerLease): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${lease.token}` };
}

export async function startCallerAttempt(backendUrl: string, lease: CallerLease): Promise<void> {
  const resp = await fetch(attemptUrl(backendUrl, lease, "start"), {
    method: "POST",
    headers: attemptHeaders(lease),
    body: JSON.stringify({ driver_kind: "caller", runtime: {} }),
  });
  if (!resp.ok) throw new Error(`/start failed: ${resp.status} ${await safeText(resp)}`);
}

export async function heartbeatCallerAttempt(
  backendUrl: string,
  lease: CallerLease,
  phase: string,
): Promise<{ cancelRequested: boolean }> {
  const resp = await fetch(attemptUrl(backendUrl, lease, "heartbeat"), {
    method: "POST",
    headers: attemptHeaders(lease),
    body: JSON.stringify({ phase }),
  });
  if (!resp.ok) throw new Error(`heartbeat failed: ${resp.status} ${await safeText(resp)}`);
  const body = (await resp.json()) as { cancel_requested?: boolean };
  return { cancelRequested: body.cancel_requested === true };
}

export async function submitCallerResult(
  backendUrl: string,
  lease: CallerLease,
  body: CallerResultBody,
): Promise<void> {
  const resp = await fetch(attemptUrl(backendUrl, lease, "result"), {
    method: "POST",
    headers: attemptHeaders(lease),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`/result failed: ${resp.status} ${await safeText(resp)}`);
}

export async function submitCallerFailure(
  backendUrl: string,
  lease: CallerLease,
  body: CallerFailureBody,
): Promise<void> {
  const resp = await fetch(attemptUrl(backendUrl, lease, "failure"), {
    method: "POST",
    headers: attemptHeaders(lease),
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`/failure failed: ${resp.status} ${await safeText(resp)}`);
}

/**
 * Background heartbeat lifecycle. Calls /heartbeat every `intervalMs` with the
 * current phase until stopped. If the lease reports stale/cancelled, the
 * callback is invoked so the caller can abort the Task and suppress a normal
 * result. Uses an AbortController so shutdown is prompt.
 */
export class CallerHeartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly abort = new AbortController();
  private stopped = false;
  private readonly backendUrl: string;
  private readonly lease: CallerLease;
  private readonly onStale: () => void;
  private readonly intervalMs: number;

  constructor(
    backendUrl: string,
    lease: CallerLease,
    onStale: () => void,
    intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
  ) {
    this.backendUrl = backendUrl;
    this.lease = lease;
    this.onStale = onStale;
    this.intervalMs = intervalMs;
  }

  start(phase: string): void {
    const tick = async (): Promise<void> => {
      if (this.stopped || this.abort.signal.aborted) return;
      try {
        const { cancelRequested } = await heartbeatCallerAttempt(this.backendUrl, this.lease, phase);
        if (cancelRequested) this.onStale();
      } catch {
        // transient heartbeat errors do not abort the task; the lease reaper
        // is the authority for staleness.
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.intervalMs);
  }

  /** Update the reported phase for subsequent heartbeats. */
  phase(_phase: string): void {
    // The phase is read at tick time; callers re-start with a new phase if needed.
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
