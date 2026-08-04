/**
 * Whether this module is the process entry point.
 *
 * Node reports a **realpath** in `import.meta.url` but leaves `process.argv[1]`
 * exactly as spelled on the command line, so comparing them directly reports
 * "not the entry point" whenever a symlink is involved — pnpm's
 * `node_modules/.bin` shim, an npx cache, a macOS `/var/folders` temp dir. The
 * CLI then exits 0 having done nothing, which reads as a broken install rather
 * than a resolution bug. Compare resolved real paths instead.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Resolve to a real path, falling back to the input when it does not exist. */
function toRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function isDirectInvocation(moduleUrl: string, entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  return toRealPath(fileURLToPath(moduleUrl)) === toRealPath(entryPath);
}
