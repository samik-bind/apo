/**
 * CLI filesystem walker for a caller workspace.
 *
 * Walks a source root, applies the required exclusions and limits, reads each
 * surviving regular/executable file, and feeds the result to the shared
 * canonicalizer exported from ``@apo/sdk/agent-task``. The walker never
 * maintains a second digest algorithm and never follows links.
 *
 * This module is consumed by SPEC-145 (caller executor CLI migration). For
 * SPEC-142 it only ships the library + tests.
 */

import { readFileSync, readdirSync, lstatSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  buildManifest,
  contentSha256,
  type ManifestFileInput,
  type TaskRevisionManifestV1,
} from "@apo/sdk/agent-task";

/** Limits enforced before a Batch is persisted. */
export interface RevisionLimits {
  maxFileCount: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxPathSegmentBytes: number;
  maxPathBytes: number;
}

/** SPEC-142 §Limits defaults. The compressed-bundle limit is bundle-level. */
export const DEFAULT_REVISION_LIMITS: RevisionLimits = {
  maxFileCount: 50_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxPathSegmentBytes: 256,
  maxPathBytes: 4_096,
};

export interface WalkOptions {
  rootDir: string;
  limits?: Partial<RevisionLimits>;
}

export interface WalkedRevision {
  manifest: TaskRevisionManifestV1;
  contentSha256: string;
}

export type TaskRevisionWalkErrorKind = "limit";

export class TaskRevisionWalkError extends Error {
  readonly kind: TaskRevisionWalkErrorKind;
  constructor(kind: TaskRevisionWalkErrorKind, message: string) {
    super(message);
    this.name = "TaskRevisionWalkError";
    this.kind = kind;
  }
}

/** Directory basenames always excluded (caches, venvs, build output, apo state). */
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".gradle",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".coverage",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".apo",
]);

/** Exact file basenames always excluded (credentials/secret-bearing). */
const EXCLUDED_FILE_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  ".DS_Store",
  "thumbs.db",
]);

function isExcludedFile(name: string): boolean {
  return EXCLUDED_FILE_NAMES.has(name) || name.startsWith(".env.");
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Walk ``rootDir`` and build the canonical manifest + contentSha256.
 *
 * Excludes secrets/caches/venv/build-output/apo-state, never follows links,
 * and rejects (typed) when any §Limit is exceeded. Exclusion counts in the
 * summary are bounded by entry, not by the contents of an excluded directory,
 * so they never reveal secret-looking filenames.
 */
export function walkWorkspaceForRevision(opts: WalkOptions): WalkedRevision {
  const limits = { ...DEFAULT_REVISION_LIMITS, ...opts.limits };
  const inputs: ManifestFileInput[] = [];
  let totalBytes = 0;
  let excludedFiles = 0;
  let excludedDirs = 0;

  const stack: string[] = [opts.rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      excludedDirs += 1;
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: Stats;
      try {
        st = lstatSync(full); // lstat: never follow links
      } catch {
        excludedFiles += 1;
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(name)) {
          excludedDirs += 1;
        } else {
          stack.push(full);
        }
        continue;
      }
      if (!st.isFile()) {
        // symlinks, sockets, devices, FIFOs — never read, bounded count
        excludedFiles += 1;
        continue;
      }
      if (isExcludedFile(name)) {
        excludedFiles += 1;
        continue;
      }

      const rel = relative(opts.rootDir, full).split(sep).join("/");
      // Validate path shape (no escape possible from a real walk, but bound it).
      const segments = rel.split("/");
      for (const seg of segments) {
        if (utf8Bytes(seg) > limits.maxPathSegmentBytes) {
          throw new TaskRevisionWalkError(
            "limit",
            `path segment exceeds ${limits.maxPathSegmentBytes}-byte limit`,
          );
        }
      }
      if (utf8Bytes(rel) > limits.maxPathBytes) {
        throw new TaskRevisionWalkError("limit", `path exceeds ${limits.maxPathBytes}-byte limit`);
      }

      if (st.size > limits.maxFileBytes) {
        throw new TaskRevisionWalkError(
          "limit",
          `file ${name} exceeds ${limits.maxFileBytes}-byte per-file limit`,
        );
      }
      if (totalBytes + st.size > limits.maxTotalBytes) {
        throw new TaskRevisionWalkError(
          "limit",
          `workspace exceeds ${limits.maxTotalBytes}-byte total-size limit`,
        );
      }

      const content = readFileSync(full);
      inputs.push({
        path: rel,
        modeClass: (st.mode & 0o111) !== 0 ? "executable" : "regular",
        content: new Uint8Array(content),
      });
      totalBytes += st.size;

      if (inputs.length > limits.maxFileCount) {
        throw new TaskRevisionWalkError(
          "limit",
          `workspace exceeds ${limits.maxFileCount}-file limit`,
        );
      }
    }
  }

  const manifest = buildManifest(inputs, {
    excludedFileCount: excludedFiles,
    excludedDirectoryCount: excludedDirs,
  });
  return { manifest, contentSha256: contentSha256(manifest) };
}
