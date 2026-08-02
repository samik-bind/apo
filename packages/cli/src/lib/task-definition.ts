/**
 * SPEC-169: Canonical Task Definition source.
 *
 * The exact `*.eval.ts` text that defines a Task and its Tests. Normalized,
 * digested, and stored privately by Apo so the dashboard can show CodeMirror
 * with the historical source that produced stored Check evidence — without
 * giving Apo the application repository or executing customer code.
 */

import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { TaskMeta } from "./task-meta.ts";

const MAX_DEFINITION_BYTES = 1_000_000;

export interface TaskDefinitionFile {
  /** Relative to the Task directory; canonical basename. */
  path: string;
  /** Normalized UTF-8 text: BOM removed, CRLF/CR → LF. */
  content: string;
}

export interface TaskDefinitionDocument {
  schema_version: 1;
  files: [TaskDefinitionFile];
}

export interface PreparedTaskDefinition {
  document: TaskDefinitionDocument;
  /** sha256:<lowercase-hex> over the canonical document JSON. */
  digest: string;
  /** UTF-8 byte count of the normalized content. */
  sizeBytes: number;
}

/**
 * Prepare the canonical Task definition from a discovered Task's directory.
 *
 * Reads the single `*.eval.ts` file, normalizes line endings and BOM,
 * digests it, and returns the immutable document. Throws on ambiguous
 * discovery, symlinks, invalid UTF-8, NUL bytes, or oversize files.
 */
export function prepareTaskDefinition(task: TaskMeta): PreparedTaskDefinition {
  const filePath = join(task.path, task.evalFileName);

  // Reject symlinks — never follow.
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new TaskDefinitionError(
      `symlink_eval_file: ${task.evalFileName} is a symlink; Task definitions must be regular files`,
    );
  }

  // Read raw bytes and validate UTF-8.
  const rawBuffer = readFileSync(filePath);
  if (rawBuffer.length === 0) {
    throw new TaskDefinitionError(`empty_eval_file: ${task.evalFileName} is empty`);
  }
  if (rawBuffer.length > MAX_DEFINITION_BYTES) {
    throw new TaskDefinitionError(
      `oversize_eval_file: ${task.evalFileName} exceeds ${MAX_DEFINITION_BYTES} bytes`,
    );
  }

  let content = rawBuffer.toString("utf-8");

  // Validate: no NUL bytes.
  if (content.includes("\0")) {
    throw new TaskDefinitionError(`nul_in_eval_file: ${task.evalFileName} contains NUL bytes`);
  }

  // Normalize: strip BOM.
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  // Normalize: CRLF/CR → LF.
  content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const file: TaskDefinitionFile = {
    path: task.evalFileName,
    content,
  };

  const document: TaskDefinitionDocument = {
    schema_version: 1,
    files: [file],
  };

  const digest = computeTaskDefinitionDigest(document);
  const sizeBytes = Buffer.byteLength(content, "utf-8");

  return { document, digest, sizeBytes };
}

/**
 * Compute the canonical SHA-256 digest of a Task Definition document.
 *
 * Matches the Python backend's compute_task_definition_digest: compact JSON
 * with sorted keys over `{schema_version, files: [{path, content}]}`.
 */
export function computeTaskDefinitionDigest(document: TaskDefinitionDocument): string {
  const stable = stableCanonicalize(document);
  const payload = JSON.stringify(stable);
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}

function stableCanonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = stableCanonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export class TaskDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskDefinitionError";
  }
}

export { MAX_DEFINITION_BYTES };
