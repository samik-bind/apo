/**
 * SPEC-161 parent-side spawner for source-owned Task execution.
 *
 * Spawns one isolated child per Attempt (``internal/run-task-child.ts``),
 * builds a sanitized child environment that injects only Task-scoped Apo
 * values and strips the User API key / Executor Credential, enforces the
 * assignment timeout, and performs cancellation via SIGTERM → 5s grace →
 * SIGKILL. The structured ``runTaskDir`` summary is read from a dedicated IPC
 * file descriptor (fd 3) so Task stdout/stderr cannot corrupt it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD_SCRIPT = fileURLToPath(
  new URL("../internal/run-task-child.ts", import.meta.url),
);

/** Env vars that must never reach Task code. */
const STRIPPED_ENV_KEYS = [
  "APO_API_KEY",
  "APO_EXECUTOR_CREDENTIAL",
  "APO_ENROLLMENT_TOKEN",
  "APO_BOOTSTRAP_TOKEN",
] as const;

/** Grace period after SIGTERM before force-killing a timed-out/cancelled child. */
const SHUTDOWN_GRACE_MS = 5_000;

/** Bounded capture window for child stdout/stderr tails. */
const CAPTURE_TAIL_BYTES = 10_000;

export interface TaskChildOptions {
  taskDir: string;
  /** Absolute directory used as the .env lookup root (mirrors task-run.ts). */
  envRoot: string;
  /** Task-scoped values injected from the assignment. */
  traceEndpoint: string;
  project: string;
  taskRunId: string;
  traceRequired: boolean;
  attemptJwt: string;
  /** Assignment timeout in seconds. */
  timeoutSeconds: number;
  /** AbortSignal that cancels the child (Control-Plane cancellation / shutdown). */
  cancelSignal?: AbortSignal;
}

export interface TaskChildSuccess {
  ok: true;
  summary: Record<string, unknown>;
  stdoutTail: string;
  stderrTail: string;
  timedOut: false;
}
export interface TaskChildFailure {
  ok: false;
  error: string;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

/**
 * Build the child environment: copy ``process.env``, layer local ``.env``
 * values on top (without mutating the parent), inject only Task-scoped Apo
 * values, and strip the User/Executor credentials. Local provider/company
 * variables are inherited unchanged — the source-owning machine is authority.
 */
export function buildChildEnv(opts: TaskChildOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  delete env.APO_AUTH_TOKEN; // never inherit a previous token

  layerEnvFiles(env, opts.envRoot);

  env.AGENT_TASK_TRACE_ENDPOINT = opts.traceEndpoint;
  env.AGENT_TASK_PROJECT = opts.project;
  env.AGENT_TASK_RUN_ID = opts.taskRunId;
  env.AGENT_TASK_TRACE_REQUIRED = opts.traceRequired ? "true" : "false";
  env.APO_AUTH_TOKEN = opts.attemptJwt;
  env.APO_CHILD_TASK_DIR = opts.taskDir;
  env.APO_CHILD_RESULT_FD = "3";
  return env;
}

/**
 * Mirror ``task-run.ts::loadEnvFiles`` precedence without mutating the parent
 * process: the first ``.env`` to define a key wins (it would already be in
 * ``process.env``); here we only fill keys that are still unset.
 */
function layerEnvFiles(env: NodeJS.ProcessEnv, taskDir: string): void {
  const candidates = [
    resolve(taskDir, ".env"),
    resolve(taskDir, "../../.env"),
    resolve(process.cwd(), "backend/.env"),
    resolve(process.cwd(), "apps/example-service/.env"),
    resolve(process.cwd(), ".env"),
  ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
        if (key && !(key in env)) env[key] = val;
      }
    } catch {
      // skip unreadable
    }
  }
}

/**
 * Spawn the Task child, enforce the timeout, honor cancellation, and return
 * the structured summary from the IPC fd. Rejects only on spawn failure; a
 * Task crash or timeout resolves as a ``TaskChildFailure`` so the caller can
 * finalize the Attempt with an honest failure_kind.
 */
export function runTaskChild(opts: TaskChildOptions): Promise<TaskChildSuccess | TaskChildFailure> {
  return new Promise((resolvePromise, reject) => {
    const env = buildChildEnv(opts);
    let stdoutTail = "";
    let stderrTail = "";
    let resultLine = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(process.execPath, ["--experimental-strip-types", CHILD_SCRIPT], {
      env,
      stdio: ["ignore", "pipe", "pipe", "pipe"], // stdin, stdout, stderr, fd3 (IPC)
    });

    const pushTail = (buf: string, chunk: Buffer): string => {
      const next = buf + chunk.toString("utf8");
      return next.length > CAPTURE_TAIL_BYTES
        ? next.slice(next.length - CAPTURE_TAIL_BYTES)
        : next;
    };

    if (child.stdout) child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      stdoutTail = pushTail(stdoutTail, chunk);
    });
    if (child.stderr) child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = pushTail(stderrTail, chunk);
    });
    const ipc = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
    if (ipc) ipc.on("data", (chunk: Buffer) => { resultLine += chunk.toString("utf8"); });

    const finish = (outcome: TaskChildSuccess | TaskChildFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.cancelSignal?.removeEventListener("abort", onCancel);
      resolvePromise(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
    }, opts.timeoutSeconds * 1000);

    const onCancel = () => terminate(child);
    opts.cancelSignal?.addEventListener("abort", onCancel);

    child.on("error", (err) => {
      // Spawn-level failure (e.g. node missing) — not a Task outcome.
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      const trimmed = resultLine.trim();
      if (trimmed) {
        try {
          const parsed = JSON.parse(trimmed) as { ok: boolean; summary?: unknown; error?: string };
          if (parsed.ok && parsed.summary) {
            return finish({
              ok: true,
              summary: parsed.summary as Record<string, unknown>,
              stdoutTail,
              stderrTail,
              timedOut: false,
            });
          }
          return finish({
            ok: false,
            error: parsed.error ?? "task child reported failure",
            stdoutTail,
            stderrTail,
            timedOut,
          });
        } catch {
          // fall through to no-result handling
        }
      }
      finish({
        ok: false,
        error: timedOut ? "task_timeout" : "task child produced no result",
        stdoutTail,
        stderrTail,
        timedOut,
      });
    });
  });
}

/** SIGTERM → grace → SIGKILL. Idempotent. */
function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // ignore — best-effort
  }
  setTimeout(() => {
    if (child.exitCode !== null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, SHUTDOWN_GRACE_MS).unref();
}
