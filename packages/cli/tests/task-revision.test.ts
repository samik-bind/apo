import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { walkWorkspaceForRevision, TaskRevisionWalkError, DEFAULT_REVISION_LIMITS } from "../src/lib/task-revision.ts";
// Contract requirement: import the canonicalizer through the package entry
// point, not an internal path.
import { buildManifest, contentSha256 } from "@apo/sdk/agent-task";

/**
 * CLI filesystem walker for a caller workspace.
 *
 * Walks a source root, applies the required exclusions and limits, reads each
 * surviving regular/executable file, and feeds the result to the shared
 * canonicalizer from @apo/sdk/agent-task. The walker never maintains a second
 * digest algorithm and never follows links.
 */

function makeTree(): string {
  return mkdtempSync(join(tmpdir(), "apo-revision-"));
}

function touch(root: string, rel: string, content: string | Buffer, mode?: number): void {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    mkdirSync(join(root, ...parts.slice(0, i + 1)), { recursive: true });
  }
  const full = join(root, ...parts);
  writeFileSync(full, content);
  if (mode !== undefined) chmodSync(full, mode);
}

describe("SPEC-142 CLI workspace walker", () => {
  let root: string;
  beforeEach(() => { root = makeTree(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("produces the canonical digest for a minimal tree (matches the corpus)", () => {
    touch(root, "README.md", "hi\n");
    const { contentSha256: digest } = walkWorkspaceForRevision({ rootDir: root });
    expect(digest).toBe("ed2aa9485ec6899605ef3f9eedea34e2416f3f88ba24a68b9923bdff661542c6");
    // Contract: the walker delegates to the package-entry-point canonicalizer,
    // which must reproduce the same digest for the same inputs.
    const viaEntryPoint = contentSha256(buildManifest([
      { path: "README.md", modeClass: "regular", content: new TextEncoder().encode("hi\n") },
    ]));
    expect(viaEntryPoint).toBe(digest);
  });

  it("excludes secrets, caches, venvs, and apo state; reports bounded counts", () => {
    touch(root, "src/main.ts", "export {}\n");
    touch(root, ".env", "SECRET=1");
    touch(root, ".env.local", "SECRET=2");
    touch(root, ".npmrc", "//registry/:_auth=...");
    touch(root, "credentials.json", '{"key":"v"}');
    touch(root, "node_modules/pkg/index.js", "module.exports=1;");
    touch(root, ".git/config", "[core]");
    touch(root, "__pycache__/x.pyc", "...");
    touch(root, "sub/.pypirc", "...");
    const { manifest } = walkWorkspaceForRevision({ rootDir: root });
    expect(manifest.files.map((f) => f.path)).toEqual(["src/main.ts"]);
    expect(manifest.summary.fileCount).toBe(1);
    expect(manifest.summary.excludedFileCount).toBe(5); // .env,.env.local,.npmrc,credentials.json,.pypirc
    expect(manifest.summary.excludedDirectoryCount).toBe(3); // node_modules,.git,__pycache__
  });

  it("detects the executable bit and records modeClass=executable", () => {
    touch(root, "run.sh", "echo hi\n", 0o755);
    touch(root, "notes.txt", "x", 0o644);
    const { manifest } = walkWorkspaceForRevision({ rootDir: root });
    const byPath = Object.fromEntries(manifest.files.map((f) => [f.path, f.modeClass]));
    expect(byPath["run.sh"]).toBe("executable");
    expect(byPath["notes.txt"]).toBe("regular");
  });

  it("never follows symlinks; escaping links are counted as excluded", () => {
    writeFileSync(join(tmpdir(), "apo-revision-outside.txt"), "OUTSIDE-SECRET");
    symlinkSync(join(tmpdir(), "apo-revision-outside.txt"), join(root, "link.txt"), "file");
    touch(root, "real.txt", "ok");
    const { manifest } = walkWorkspaceForRevision({ rootDir: root });
    expect(manifest.files.map((f) => f.path)).toEqual(["real.txt"]);
    expect(manifest.summary.excludedFileCount).toBe(1);
  });

  it("enforces the file-count limit with a typed error", () => {
    touch(root, "a.txt", "a");
    touch(root, "b.txt", "b");
    touch(root, "c.txt", "c");
    expect(() => walkWorkspaceForRevision({
      rootDir: root,
      limits: { ...DEFAULT_REVISION_LIMITS, maxFileCount: 2 },
    })).toThrow(TaskRevisionWalkError);
    try {
      walkWorkspaceForRevision({ rootDir: root, limits: { ...DEFAULT_REVISION_LIMITS, maxFileCount: 2 } });
    } catch (e) {
      expect((e as TaskRevisionWalkError).kind).toBe("limit");
    }
  });

  it("enforces the per-file size limit with a typed error", () => {
    touch(root, "big.txt", "x".repeat(10));
    expect(() => walkWorkspaceForRevision({
      rootDir: root,
      limits: { ...DEFAULT_REVISION_LIMITS, maxFileBytes: 4 },
    })).toThrow(TaskRevisionWalkError);
  });

  it("enforces the total uncompressed size limit with a typed error", () => {
    touch(root, "a.txt", "x".repeat(6));
    touch(root, "b.txt", "x".repeat(6));
    expect(() => walkWorkspaceForRevision({
      rootDir: root,
      limits: { ...DEFAULT_REVISION_LIMITS, maxTotalBytes: 8 },
    })).toThrow(TaskRevisionWalkError);
  });

  it("enforces the per-path-segment byte length limit", () => {
    touch(root, "a".repeat(20) + ".txt", "x");
    expect(() => walkWorkspaceForRevision({
      rootDir: root,
      limits: { ...DEFAULT_REVISION_LIMITS, maxPathSegmentBytes: 4 },
    })).toThrow(TaskRevisionWalkError);
  });

  it("platform-separator roots still produce POSIX paths", () => {
    touch(root, join("src", "deep", "a.ts").split(sep).join("/"), "export {}\n");
    const { manifest } = walkWorkspaceForRevision({ rootDir: root });
    expect(manifest.files[0]!.path).toBe("src/deep/a.ts");
  });
});
