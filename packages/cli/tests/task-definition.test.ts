import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareTaskDefinition,
  computeTaskDefinitionDigest,
  TaskDefinitionError,
  MAX_DEFINITION_BYTES,
  type TaskDefinitionDocument,
} from "../src/lib/task-definition.ts";
import type { TaskMeta } from "../src/lib/task-meta.ts";

function writeTask(root: string, name: string, content: string): { meta: TaskMeta } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.eval.ts`), content);
  return {
    meta: {
      id: name,
      folderPath: "",
      adapter: "test",
      hasChecks: false,
      path: dir,
      evalFileName: `${name}.eval.ts`,
      deliverables: [],
      files: [],
    },
  };
}

describe("SPEC-169: Task Definition preparation", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "apo-task-def-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("is deterministic: same content + filename from different roots produces the same digest", () => {
    const content = `import { task } from "@apo-ai/sdk/agent-task";\ntask("demo", { adapter: "a" });\n`;
    const dirA = join(tmp, "a"); mkdirSync(dirA, { recursive: true });
    const dirB = join(tmp, "b"); mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, "demo.eval.ts"), content);
    writeFileSync(join(dirB, "demo.eval.ts"), content);
    const meta: TaskMeta = {
      id: "demo", folderPath: "", adapter: "test", hasChecks: false,
      path: "", evalFileName: "demo.eval.ts",
      deliverables: [], files: [],
    };

    const pa = prepareTaskDefinition({ ...meta, path: dirA });
    const pb = prepareTaskDefinition({ ...meta, path: dirB });

    expect(pa.digest).toBe(pb.digest);
    expect(pa.document.files[0]!.content).toBe(pb.document.files[0]!.content);
    expect(pa.document.files[0]!.path).toBe(pb.document.files[0]!.path);
  });

  it("normalizes BOM and CRLF to LF", () => {
    const bom = "\uFEFF";
    const crlf = "import { task } from \"@apo-ai/sdk/agent-task\";\r\ntask(\"demo\", { adapter: \"a\" });\r\n";
    const { meta } = writeTask(tmp, "crlf-task", bom + crlf);

    const prepared = prepareTaskDefinition(meta);

    expect(prepared.document.files[0]!.content).not.toContain("\uFEFF");
    expect(prepared.document.files[0]!.content).not.toContain("\r\n");
    expect(prepared.document.files[0]!.content).not.toContain("\r");
    expect(prepared.document.files[0]!.content).toContain("\n");
  });

  it("preserves every other byte after normalization", () => {
    const content = "import { task } from \"@apo-ai/sdk/agent-task\";\n// emoji: 🎉 tabs:\there\n";
    const { meta } = writeTask(tmp, "unicode-task", content);

    const prepared = prepareTaskDefinition(meta);
    expect(prepared.document.files[0]!.content).toBe(content);
  });

  it("uses only the basename as the path, never an absolute path", () => {
    const { meta } = writeTask(tmp, "path-task", "task('x', { adapter: 'a' });");
    const prepared = prepareTaskDefinition(meta);
    expect(prepared.document.files[0]!.path).toBe("path-task.eval.ts");
    expect(prepared.document.files[0]!.path).not.toContain("/");
  });

  it("rejects NUL bytes", () => {
    const { meta } = writeTask(tmp, "nul-task", "task('x', { adapter: 'a' });\0");
    expect(() => prepareTaskDefinition(meta)).toThrow(TaskDefinitionError);
    expect(() => prepareTaskDefinition(meta)).toThrow(/nul/i);
  });

  it("rejects a symlink eval file", () => {
    const realDir = join(tmp, "real-task");
    const linkDir = join(tmp, "link-task");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "real-task.eval.ts"), "task('x', { adapter: 'a' });");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(join(realDir, "real-task.eval.ts"), join(linkDir, "link-task.eval.ts"));

    expect(() => prepareTaskDefinition({
      id: "link-task", folderPath: "", adapter: "test", hasChecks: false,
      path: linkDir, evalFileName: "link-task.eval.ts",
      deliverables: [], files: [],
    })).toThrow(/symlink/i);
  });

  it("digest changes when source content changes", () => {
    const a = writeTask(tmp, "v1", "task('x', { adapter: 'a' });\n");
    const b = writeTask(tmp, "v2", "task('x', { adapter: 'b' });\n");
    const pa = prepareTaskDefinition(a.meta);
    const pb = prepareTaskDefinition(b.meta);
    expect(pa.digest).not.toBe(pb.digest);
  });

  it("computeTaskDefinitionDigest matches prepareTaskDefinition digest", () => {
    const { meta } = writeTask(tmp, "digest-check", "task('x', { adapter: 'a' });\n");
    const prepared = prepareTaskDefinition(meta);
    const recomputed = computeTaskDefinitionDigest(prepared.document);
    expect(recomputed).toBe(prepared.digest);
  });
});
