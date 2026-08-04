import { describe, expect, it, vi } from "vitest";

import { loadCheckSource, type DefinitionRef, type LoadCheckSourceDeps } from "../load-check-source";

/**
 * The compare view rendered "Task not found" for every check when recording to
 * a hosted backend: it resolved source only through `readTaskFile`, which
 * discovers tasks on the *backend's* filesystem, so tasks executing on a
 * developer machine could never be found.
 *
 * The pinned Task Definition (SPEC-169) is the authoritative source and is
 * already stored per-run. These tests pin the precedence the run detail view
 * established — definition first, the retired filesystem resolver only as a
 * legacy fallback — as a pure function, because the vitest JSX transform in
 * this repo cannot parse .tsx imports.
 */

const DEFINITION = { content: 'test("C-001", () => {})', language: "typescript" };
const FILESYSTEM = { content: 'test("C-001", () => { /* from disk */ })', language: "typescript" };

const notFound = (taskId: string) => new Error(`Task not found: ${taskId}`);

const makeDeps = (overrides: Partial<LoadCheckSourceDeps> = {}): LoadCheckSourceDeps => ({
  readDefinitionSource: vi.fn(async () => DEFINITION),
  readTaskFile: vi.fn(async () => FILESYSTEM),
  ...overrides,
});

const REFS: DefinitionRef[] = [
  { runId: "run_a", filePath: "cost-inquiry.eval.ts" },
  { runId: "run_b", filePath: "cost-inquiry.eval.ts" },
];

const load = (args: {
  deps: LoadCheckSourceDeps;
  definitionRefs?: DefinitionRef[];
  commitSha?: string | null;
  recordedSourceFile?: string;
}) =>
  loadCheckSource({
    taskId: "chat/cost-inquiry",
    recordedSourceFile: args.recordedSourceFile ?? "cost-inquiry.eval.ts",
    commitSha: args.commitSha ?? null,
    definitionRefs: args.definitionRefs ?? REFS,
    containsKnownCheck: (content) => content.includes('test("C-001"'),
    deps: args.deps,
  });

describe("loadCheckSource", () => {
  it("prefers the pinned Task Definition and never touches the filesystem resolver", async () => {
    const deps = makeDeps();

    const source = await load({ deps });

    expect(source.content).toBe(DEFINITION.content);
    expect(deps.readDefinitionSource).toHaveBeenCalledWith("run_a", "cost-inquiry.eval.ts");
    expect(deps.readTaskFile).not.toHaveBeenCalled();
  });

  it("returns the definition even when the filesystem resolver would 404 — the original bug", async () => {
    const deps = makeDeps({
      readTaskFile: vi.fn(async () => {
        throw notFound("chat/cost-inquiry");
      }),
    });

    const source = await load({ deps });

    expect(source.content).toBe(DEFINITION.content);
  });

  it("tries the other run's definition when the first run's read fails", async () => {
    const readDefinitionSource = vi.fn(async (runId: string) => {
      if (runId === "run_a") throw new Error("definition_source_not_found");
      return DEFINITION;
    });

    const source = await load({ deps: makeDeps({ readDefinitionSource }) });

    expect(source.content).toBe(DEFINITION.content);
    expect(readDefinitionSource).toHaveBeenCalledTimes(2);
  });

  it("falls back to the filesystem resolver when no definition is pinned", async () => {
    const deps = makeDeps();

    const source = await load({ deps, definitionRefs: [] });

    expect(source.content).toBe(FILESYSTEM.content);
    expect(deps.readDefinitionSource).not.toHaveBeenCalled();
  });

  it("falls back to the filesystem resolver when every definition read fails", async () => {
    const deps = makeDeps({
      readDefinitionSource: vi.fn(async () => {
        throw new Error("definition_source_not_found");
      }),
    });

    const source = await load({ deps });

    expect(source.content).toBe(FILESYSTEM.content);
    expect(deps.readTaskFile).toHaveBeenCalled();
  });

  it("retries the filesystem resolver without the commit sha", async () => {
    // A run with no published repository has task_source_commit_sha = null;
    // a stale/unknown sha must not strand the viewer.
    const readTaskFile = vi.fn(async (_taskId: string, _candidate: string, commitSha?: string) => {
      if (commitSha) throw new Error("unknown revision");
      return FILESYSTEM;
    });

    const source = await load({
      deps: makeDeps({ readTaskFile }),
      definitionRefs: [],
      commitSha: "deadbeef",
    });

    expect(source.content).toBe(FILESYSTEM.content);
    expect(readTaskFile).toHaveBeenCalledTimes(2);
  });

  it("surfaces the last error when neither source resolves", async () => {
    const deps = makeDeps({
      readDefinitionSource: vi.fn(async () => {
        throw new Error("definition_source_not_found");
      }),
      readTaskFile: vi.fn(async () => {
        throw notFound("chat/cost-inquiry");
      }),
    });

    await expect(load({ deps })).rejects.toThrow("Task not found: chat/cost-inquiry");
  });

  it("skips a definition ref that carries no file path", async () => {
    const readDefinitionSource = vi.fn(async () => DEFINITION);

    const source = await load({
      deps: makeDeps({ readDefinitionSource }),
      definitionRefs: [{ runId: "run_a", filePath: "" }, REFS[1]],
    });

    expect(source.content).toBe(DEFINITION.content);
    expect(readDefinitionSource).toHaveBeenCalledTimes(1);
    expect(readDefinitionSource).toHaveBeenCalledWith("run_b", "cost-inquiry.eval.ts");
  });
});
