import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentials from "../src/lib/credentials.ts";
import { run } from "../src/commands/task-list.ts";
import { stripAnsi } from "../src/lib/format.ts";

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  return { logs, restore: () => { console.log = original; } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  return { errors, restore: () => { console.error = original; } };
}

function writeTask(root: string): void {
  const taskDir = join(root, "list-task");
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "list-task.eval.ts"),
    `import { task } from "@apo-ai/sdk/agent-task";\ntask("list-task", { adapter: "a" });`,
  );
}

describe("task list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 with a fix hint when the task root does not exist", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(null);
    const { errors, restore } = captureError();

    const code = await run(["--dir", "/nonexistent-apo-task-root"]);

    restore();
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("Task root not found");
    expect(errors.join("\n")).toContain("--dir");
  });

  it("explicit --dir scans locally even when a backend project is configured", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "apo-task-list-"));
    writeTask(testDir);
    try {
      vi.spyOn(credentials, "readCredentials").mockReturnValue({
        backend_url: "http://backend.test",
        api_key: "sk-test",
        project: "proj-x",
      });
      // Any fetch (health or catalog) would be wrong here: --dir means local.
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
      const { logs, restore } = captureLog();

      const code = await run(["--dir", testDir]);

      restore();
      const out = stripAnsi(logs.join("\n"));
      expect(code).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out).toContain("list-task");
      expect(out).toContain(`scanned ${testDir}`);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("defaults to the backend catalog and names the project as the source", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-test",
      project: "proj-x",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/health")) return new Response("ok", { status: 200 });
      if (url.includes("/v1/projects/proj-x/agent-tasks")) {
        return new Response(
          JSON.stringify([{ id: "catalog/task-a", adapter_name: "demoAdapter", has_checks: true }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const { logs, restore } = captureLog();

    const code = await run([]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain("catalog/task-a");
    expect(out).toContain("backend catalog (project proj-x)");
  });
});
