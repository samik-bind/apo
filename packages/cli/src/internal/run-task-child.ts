/**
 * Child entrypoint for source-owned Task execution.
 *
 * Spawned one-per-Attempt by the Connected Executor parent (connect.ts). It
 * imports ``runTaskDir`` from the SDK and runs the Task in this isolated
 * child process so Task stdout/stderr cannot corrupt the parent's claim loop
 * or the result message. The structured summary is written to a dedicated IPC
 * file descriptor (fd 3) as a single JSON line; stdout/stderr pass through
 * unchanged for human-readable logs.
 *
 * The task directory travels via the ``APO_CHILD_TASK_DIR`` env var — never
 * from the Control Plane. Task-scoped Apo values (trace endpoint, project,
 * run id, Attempt JWT) are injected by the parent; this process must not see
 * the User API key or Executor Credential.
 */

import { runTaskDir } from "@apo-ai/sdk/agent-task";
import { writeSync } from "node:fs";

const taskDir = process.env.APO_CHILD_TASK_DIR;
const resultFd = Number(process.env.APO_CHILD_RESULT_FD ?? "3");

interface ChildSuccess {
  ok: true;
  summary: Record<string, unknown>;
}
interface ChildFailure {
  ok: false;
  error: string;
}

function writeResult(payload: ChildSuccess | ChildFailure): void {
  try {
    const line = JSON.stringify(payload) + "\n";
    // fd 3 is inherited from the parent as a writable pipe; if it is missing
    // the parent will time out and report a runtime failure rather than trust stdout.
    writeSync(resultFd, line);
  } catch {
    // best-effort — the dedicated fd is the contract
  }
}

async function main(): Promise<number> {
  if (!taskDir) {
    writeResult({ ok: false, error: "APO_CHILD_TASK_DIR not set" });
    return 1;
  }
  try {
    const summary = await runTaskDir(taskDir);
    writeResult({
      ok: true,
      summary: summary as unknown as Record<string, unknown>,
    });
    return 0;
  } catch (err) {
    writeResult({ ok: false, error: (err as Error).message || String(err) });
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    writeResult({ ok: false, error: (err as Error).message || String(err) });
    process.exit(1);
  });
