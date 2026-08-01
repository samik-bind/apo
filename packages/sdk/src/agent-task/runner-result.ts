/**
 * atomic, bounded Task result writer.
 *
 * The Bundled Executor reads the result ONLY from `AGENT_TASK_RESULT_PATH`
 * (stdout JSON is diagnostic and can never replace it). This writer is
 * extracted from `runner-entry.ts` so it is independently testable: it writes
 * a temp file, fsyncs, and atomically renames, so the driver never observes a
 * partial result. A body over the 10 MiB bound is left unwritten so the driver
 * classifies it as `result_invalid` rather than persisting a truncated object.
 */

import { mkdirSync, openSync, writeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";

export const RESULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Write `body` to `resultPath` atomically. Returns true on success, false if
 * the body exceeded the bound (left unwritten so the driver reports
 * `result_invalid`).
 */
export function writeResultAtomically(resultPath: string, body: string): boolean {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > RESULT_MAX_BYTES) {
    return false;
  }
  const lastSlash = resultPath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? resultPath.slice(0, lastSlash) : ".";
  mkdirSync(dir, { recursive: true });
  const tmp = `${resultPath}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, body);
    fsyncSync(fd);
    renameSync(tmp, resultPath);
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        unlinkSync(tmp);
      } catch {
        // already renamed or absent; ignore
      }
    }
  }
}
