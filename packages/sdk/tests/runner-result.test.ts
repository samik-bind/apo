import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, beforeEach } from "vitest";

import { writeResultAtomically, RESULT_MAX_BYTES } from "../src/agent-task/runner-result.ts";

/**
 * the Bundled Executor reads the result only from the result file;
 * this writer is atomic (temp + fsync + rename), bounded to 10 MiB, and creates
 * the parent directory.
 */

describe("SPEC-144 runner-result writer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "apo-runner-result-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the result atomically to AGENT_TASK_RESULT_PATH", () => {
    const path = join(dir, "ws", ".apo-result", "result.json");
    const ok = writeResultAtomically(path, JSON.stringify({ pass: true, adapterName: "openai" }));
    expect(ok).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pass: true, adapterName: "openai" });
  });

  it("leaves no temp file behind after success", () => {
    const { readdirSync } = require("node:fs");
    const path = join(dir, "result.json");
    writeResultAtomically(path, "{}");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["result.json"]);
  });

  it("refuses to write a result over the 10 MiB bound", () => {
    const path = join(dir, "result.json");
    const huge = "x".repeat(RESULT_MAX_BYTES + 1);
    const ok = writeResultAtomically(path, huge);
    expect(ok).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});
