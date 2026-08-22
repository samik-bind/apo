import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backendKey,
  forgetRememberedLogin,
  listRememberedLogins,
  readRememberedLogin,
  writeRememberedLogin,
} from "../src/lib/credentials.ts";

describe("remembered logins storage", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "apo-logins-test-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.USERPROFILE;
  });

  it("keys logins by host, ignoring trailing slashes", () => {
    expect(backendKey("http://localhost:8000")).toBe(backendKey("http://localhost:8000/"));
    expect(backendKey("https://apo.example.com")).toBe("apo.example.com");
    expect(backendKey("http://localhost:8000/subpath")).toContain("localhost_8000");
  });

  it("round-trips a remembered login", () => {
    writeRememberedLogin({
      backend_url: "http://localhost:8000",
      api_key: "sk-1",
      email: "dev@apo.local",
      project: "p1",
      task_root: "/repo/e2e",
    });
    const read = readRememberedLogin("http://localhost:8000/");
    expect(read?.api_key).toBe("sk-1");
    expect(read?.task_root).toBe("/repo/e2e");
  });

  it("lists and forgets remembered logins", () => {
    writeRememberedLogin({ backend_url: "http://a.example", api_key: "k1", email: "x@a" });
    writeRememberedLogin({ backend_url: "http://b.example", api_key: "k2", email: "x@b" });
    expect(listRememberedLogins().map((l) => l.backend_url)).toEqual([
      "http://a.example",
      "http://b.example",
    ]);
    expect(forgetRememberedLogin("http://a.example")).toBe(true);
    expect(readRememberedLogin("http://a.example")).toBeNull();
    expect(forgetRememberedLogin("http://a.example")).toBe(false);
  });

  it("skips corrupt files when listing", () => {
    const dir = join(home, ".apo", "logins");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "garbage.json"), "{not json");
    writeRememberedLogin({ backend_url: "http://c.example", api_key: "k3" });
    expect(listRememberedLogins()).toHaveLength(1);
  });

  it("writes with 0600 permissions", () => {
    writeRememberedLogin({ backend_url: "http://d.example", api_key: "k4" });
    const mode = statSync(join(home, ".apo", "logins", "d.example.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
