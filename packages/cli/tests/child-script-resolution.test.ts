/**
 * The Connected Executor spawns the Task child by path, not by import, so the
 * bundler cannot follow it. That makes the resolution rules the only thing
 * standing between a published artifact and an executor that claims work it
 * can never run (#109): the built package has `internal/run-task-child.js`
 * next to the chunk that spawns it, while monorepo dev runs from `src/` where
 * the child is a sibling directory away and still TypeScript.
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  resolveChildScript,
  resolveTsxImportHook,
} from "../src/lib/local-task-child.ts";

/** A file URL for a module living at `<dir>/<name>`, as `import.meta.url` would be. */
function moduleUrlIn(dir: string, name: string): string {
  return pathToFileURL(join(dir, name)).href;
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "apo-child-resolve-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveChildScript", () => {
  it("resolves the compiled child in the built package layout", () => {
    withTempDir((dir) => {
      // dist/: the spawning code is a flat chunk, the child a built subpath.
      mkdirSync(join(dir, "internal"), { recursive: true });
      const child = join(dir, "internal", "run-task-child.js");
      writeFileSync(child, "// built child\n");

      expect(resolveChildScript(moduleUrlIn(dir, "connect-ABCD1234.js"))).toBe(child);
    });
  });

  it("resolves the TypeScript child in the source layout", () => {
    withTempDir((dir) => {
      // src/: lib/local-task-child.ts spawns ../internal/run-task-child.ts.
      mkdirSync(join(dir, "lib"), { recursive: true });
      mkdirSync(join(dir, "internal"), { recursive: true });
      const child = join(dir, "internal", "run-task-child.ts");
      writeFileSync(child, "// source child\n");

      expect(resolveChildScript(moduleUrlIn(join(dir, "lib"), "local-task-child.ts"))).toBe(child);
    });
  });

  it("prefers the compiled child when both layouts are present", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "internal"), { recursive: true });
      const compiled = join(dir, "internal", "run-task-child.js");
      writeFileSync(compiled, "// built child\n");
      writeFileSync(join(dir, "internal", "run-task-child.ts"), "// source child\n");

      expect(resolveChildScript(moduleUrlIn(dir, "connect-ABCD1234.js"))).toBe(compiled);
    });
  });

  it("throws naming the searched paths when the child is missing", () => {
    withTempDir((dir) => {
      expect(() => resolveChildScript(moduleUrlIn(dir, "connect-ABCD1234.js"))).toThrow(
        /run-task-child/,
      );
      // The message must be actionable: a missing child is a packaging fault,
      // not a Task fault, and previously surfaced per-assignment as an opaque
      // ERR_MODULE_NOT_FOUND from the spawned process.
      expect(() => resolveChildScript(moduleUrlIn(dir, "connect-ABCD1234.js"))).toThrow(
        /internal\/run-task-child/,
      );
    });
  });
});

describe("resolveTsxImportHook", () => {
  it("resolves the installed tsx loader relative to the CLI module", () => {
    const hookUrl = resolveTsxImportHook(import.meta.url);
    const hookPath = fileURLToPath(hookUrl);

    expect(hookPath).toMatch(/[/\\]tsx[/\\].*loader\.mjs$/);
    expect(existsSync(hookPath)).toBe(true);
  });

  it("reports a missing loader as a CLI packaging fault", () => {
    withTempDir((dir) => {
      expect(() => resolveTsxImportHook(moduleUrlIn(dir, "isolated-cli.js"))).toThrow(
        /packaging fault, not a Task error/,
      );
    });
  });
});
