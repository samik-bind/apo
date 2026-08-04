/**
 * `main.ts` runs its CLI only when invoked as the entry point, so the predicate
 * deciding that is the difference between a working binary and one that exits 0
 * having printed nothing. Node's ESM loader reports a realpath in
 * `import.meta.url` but leaves `process.argv[1]` exactly as spelled, so any
 * symlink on the invocation path — pnpm's `node_modules/.bin/apo`, an npx
 * cache, macOS `/var/folders` temp dirs — makes a naive URL comparison fail.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { isDirectInvocation } from "../src/lib/entrypoint.ts";

function withTempDir(fn: (dir: string) => void): void {
  // realpath the temp root itself: on macOS `tmpdir()` is already a symlink,
  // which would otherwise make the "no symlink involved" cases untestable.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "apo-entrypoint-")));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("isDirectInvocation", () => {
  it("is true when the script is invoked by its own path", () => {
    withTempDir((dir) => {
      const script = join(dir, "main.js");
      writeFileSync(script, "// entry\n");

      expect(isDirectInvocation(pathToFileURL(script).href, script)).toBe(true);
    });
  });

  it("is true when invoked through a symlinked directory (bin shims, npx, macOS tmp)", () => {
    withTempDir((dir) => {
      const real = join(dir, "dist");
      mkdirSync(real);
      const script = join(real, "main.js");
      writeFileSync(script, "// entry\n");
      const link = join(dir, "linked");
      symlinkSync(real, link);

      // What Node reports: a realpath'd module url, an as-spelled argv[1].
      expect(isDirectInvocation(pathToFileURL(script).href, join(link, "main.js"))).toBe(true);
    });
  });

  it("is true when invoked through a symlink to the script itself", () => {
    withTempDir((dir) => {
      const script = join(dir, "main.js");
      writeFileSync(script, "// entry\n");
      const link = join(dir, "apo");
      symlinkSync(script, link);

      expect(isDirectInvocation(pathToFileURL(script).href, link)).toBe(true);
    });
  });

  it("is false when a different module is the entry point (imported, e.g. by tests)", () => {
    withTempDir((dir) => {
      const script = join(dir, "main.js");
      const other = join(dir, "runner.js");
      writeFileSync(script, "// library\n");
      writeFileSync(other, "// entry\n");

      expect(isDirectInvocation(pathToFileURL(script).href, other)).toBe(false);
    });
  });

  it("is false when there is no entry path at all (REPL, --eval)", () => {
    withTempDir((dir) => {
      const script = join(dir, "main.js");
      writeFileSync(script, "// library\n");

      expect(isDirectInvocation(pathToFileURL(script).href, undefined)).toBe(false);
    });
  });

  it("is false rather than throwing when the entry path does not exist", () => {
    withTempDir((dir) => {
      const script = join(dir, "main.js");
      writeFileSync(script, "// library\n");

      expect(isDirectInvocation(pathToFileURL(script).href, join(dir, "gone.js"))).toBe(false);
    });
  });
});
