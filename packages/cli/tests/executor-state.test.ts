import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  computeExecutorStateDir,
  saveExecutorState,
  loadExecutorState,
  type StoredExecutorState,
} from "../src/lib/executor-state.ts";

describe("executor-state", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "apo-exec-state-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  describe("computeExecutorStateDir", () => {
    it("produces a stable sha256-based directory", () => {
      const dir1 = computeExecutorStateDir("http://localhost:8000", "proj-1", "/tasks");
      const dir2 = computeExecutorStateDir("http://localhost:8000", "proj-1", "/tasks");
      expect(dir1).toBe(dir2);
      expect(dir1).toContain("apo");
      expect(dir1).toContain("executors");
    });

    it("differs for different projects", () => {
      const dir1 = computeExecutorStateDir("http://localhost:8000", "proj-1", "/tasks");
      const dir2 = computeExecutorStateDir("http://localhost:8000", "proj-2", "/tasks");
      expect(dir1).not.toBe(dir2);
    });

    it("differs for different backends", () => {
      const dir1 = computeExecutorStateDir("http://localhost:8000", "proj-1", "/tasks");
      const dir2 = computeExecutorStateDir("http://localhost:9000", "proj-1", "/tasks");
      expect(dir1).not.toBe(dir2);
    });
  });

  describe("saveExecutorState", () => {
    it("writes mode-0600 file in mode-0700 directory", () => {
      const state: StoredExecutorState = {
        schema_version: 1,
        backend_url: "http://localhost:8000",
        project_id: "proj-1",
        executor_id: "exec-1",
        executor_name: "test-machine",
        credential: "apo_ex_secret",
        created_at: new Date().toISOString(),
      };

      const path = saveExecutorState(state, { taskRoot: "/tasks" });
      expect(existsSync(path)).toBe(true);

      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it("never stores in the user credentials file", () => {
      const state: StoredExecutorState = {
        schema_version: 1,
        backend_url: "http://localhost:8000",
        project_id: "proj-1",
        executor_id: "exec-1",
        executor_name: "test-machine",
        credential: "apo_ex_secret",
        created_at: new Date().toISOString(),
      };

      saveExecutorState(state, { taskRoot: "/tasks" });
      const credPath = join(tempHome, ".apo", "credentials");
      expect(existsSync(credPath)).toBe(false);
    });
  });

  describe("loadExecutorState", () => {
    it("round-trips saved state", () => {
      const state: StoredExecutorState = {
        schema_version: 1,
        backend_url: "http://localhost:8000",
        project_id: "proj-1",
        executor_id: "exec-1",
        executor_name: "test-machine",
        credential: "apo_ex_secret",
        created_at: "2026-07-30T12:00:00Z",
      };

      saveExecutorState(state, { taskRoot: "/tasks" });
      const loaded = loadExecutorState("http://localhost:8000", "proj-1", "/tasks");

      expect(loaded).not.toBeNull();
      expect(loaded!.executor_id).toBe("exec-1");
      expect(loaded!.credential).toBe("apo_ex_secret");
    });

    it("returns null when no state exists", () => {
      const loaded = loadExecutorState("http://localhost:8000", "proj-1", "/tasks");
      expect(loaded).toBeNull();
    });
  });
});
