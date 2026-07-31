/**
 * SPEC-161: Local executor state persistence.
 *
 * Stores one executor credential per backend + project + task-root identity.
 * The raw task-root path is used only to derive the opaque state-directory
 * key. Never stores in the normal user credentials file.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface StoredExecutorState {
  schema_version: 1;
  backend_url: string;
  project_id: string;
  executor_id: string;
  executor_name: string;
  credential: string;
  created_at: string;
}

function apoDir(): string {
  return join(homedir(), ".apo");
}

export function computeExecutorStateDir(
  backendUrl: string,
  projectId: string,
  taskRoot: string,
): string {
  const identity = `${backendUrl}|${projectId}|${taskRoot}`;
  const hash = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return join(apoDir(), "executors", hash);
}

function stateFilePath(
  backendUrl: string,
  projectId: string,
  taskRoot: string,
): string {
  return join(computeExecutorStateDir(backendUrl, projectId, taskRoot), "credentials.json");
}

export function saveExecutorState(
  state: StoredExecutorState,
  opts: { taskRoot: string },
): string {
  const dir = computeExecutorStateDir(state.backend_url, state.project_id, opts.taskRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "credentials.json");
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function loadExecutorState(
  backendUrl: string,
  projectId: string,
  taskRoot: string,
): StoredExecutorState | null {
  const path = stateFilePath(backendUrl, projectId, taskRoot);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (data.schema_version === 1) return data as StoredExecutorState;
  } catch {
    // Corrupt state file — treat as absent
  }
  return null;
}
