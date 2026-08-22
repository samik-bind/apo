import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentials from "../src/lib/credentials.ts";
import { run } from "../src/commands/status.ts";
import { stripAnsi } from "../src/lib/format.ts";

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  return { logs, restore: () => { console.log = original; } };
}

describe("status command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints login, backend reachability, project, and task root", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://backend.test",
      api_key: "sk-test",
      email: "dev@test.com",
      project: "proj-1",
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const { logs, restore } = captureLog();

    const code = await run([]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain("dev@test.com");
    expect(out).toContain("http://backend.test");
    expect(out).toContain("reachable");
    expect(out).toContain("proj-1");
  });

  it("flags an unreachable backend and a missing task root", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue({
      backend_url: "http://down.test",
      api_key: "sk-test",
      project: "proj-1",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const { logs, restore } = captureLog();

    const code = await run(["--backend", "http://down.test"]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain("unreachable");
    // No task_root stored → default ./e2e, which does not exist in the test cwd.
    expect(out).toContain("directory does not exist");
  });

  it("shows a not-logged-in hint without credentials", async () => {
    vi.spyOn(credentials, "readCredentials").mockReturnValue(null);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const { logs, restore } = captureLog();

    const code = await run([]);

    restore();
    const out = stripAnsi(logs.join("\n"));
    expect(code).toBe(0);
    expect(out).toContain("not logged in");
  });
});
