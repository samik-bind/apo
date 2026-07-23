import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/commands/runs-deliverable.ts";
import { stripAnsi } from "../src/lib/format.ts";

const FULL_ID = "0123456789abcdef0123456789abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function manifest(items: Array<Record<string, unknown>>): Response {
  return jsonResponse({ task_run_id: FULL_ID, items });
}

function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function captureError(): { errors: string[]; restore: () => void } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  return { errors, restore: () => { console.error = original; } };
}

describe("runs deliverable command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the manifest endpoint (not the whole run)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      manifest([
        { id: "dlv_1", name: "memorandum", kind: "json", status: "ready", media_type: "application/json", display_filename: null, size_bytes: 5, sha256: "a".repeat(64), download_url: "/x/dlv_1" },
      ]),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://backend.test/v1/agent-task-runs/${FULL_ID}/deliverables`,
    );
    const out = stripAnsi(logs.join("\n"));
    expect(out).toContain("memorandum");
    expect(out).toContain("json");
  });

  it("fetches exactly one body when a name is given", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(
        manifest([
          { id: "dlv_1", name: "stats", kind: "json", status: "ready", media_type: "application/json", display_filename: null, size_bytes: 10, sha256: "a".repeat(64), download_url: "/x/dlv_1" },
          { id: "dlv_2", name: "summary", kind: "json", status: "ready", media_type: "application/json", display_filename: null, size_bytes: 6, sha256: "b".repeat(64), download_url: "/x/dlv_2" },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ passes: 3, fails: 1 }));
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "stats", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    // Two calls: manifest, then the one body. NOT all bodies.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `http://backend.test/v1/agent-task-runs/${FULL_ID}/deliverables/dlv_1`,
    );
    expect(logs.join("\n")).toContain('"passes"');
  });

  it("lists available names when the requested name is unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      manifest([
        { id: "dlv_1", name: "memorandum", kind: "json", status: "ready", media_type: "application/json", display_filename: null, size_bytes: 1, sha256: "a".repeat(64), download_url: null },
        { id: "dlv_2", name: "summary", kind: "json", status: "ready", media_type: "application/json", display_filename: null, size_bytes: 1, sha256: "b".repeat(64), download_url: null },
      ]),
    );
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "missing", "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    const out = stripAnsi(errors.join("\n"));
    expect(out).toContain('"missing"');
    expect(out).toContain("memorandum");
    expect(out).toContain("summary");
  });

  it("exits 2 with a usage hint when run-id is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { errors, restore } = captureError();

    const code = await run(["--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stripAnsi(errors.join("\n"))).toMatch(/run-id|usage/i);
  });

  it("reports no deliverables cleanly (exit 0)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(manifest([]));
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(0);
    expect(stripAnsi(errors.join("\n"))).toMatch(/no deliverables/i);
  });

  it("returns exit code 2 when the run is not found (404)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ detail: "not found" }, 404));
    const { errors, restore } = captureError();

    const code = await run([FULL_ID, "--backend", "http://backend.test"]);
    restore();

    expect(code).toBe(2);
    expect(stripAnsi(errors.join("\n"))).toContain("Run not found");
  });

  it("refuses to dump a binary artifact to an interactive terminal", async () => {
    const originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true as boolean;
    try {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        manifest([
          { id: "dlv_log", name: "verifier-log", kind: "artifact", status: "ready", media_type: "text/plain", display_filename: "verifier.log", size_bytes: 100, sha256: "a".repeat(64), download_url: "/x/dlv_log" },
        ]),
      );
      const { errors, restore } = captureError();

      const code = await run([FULL_ID, "verifier-log", "--backend", "http://backend.test"]);
      restore();

      expect(code).toBe(2);
      const out = stripAnsi(errors.join("\n"));
      expect(out).toMatch(/binary artifact/i);
      expect(out).toContain("--output");
    } finally {
      process.stdout.isTTY = originalIsTTY;
    }
  });

  it("writes a binary artifact to --output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deliverable-"));
    const outPath = join(dir, "out.log");
    const payload = new Uint8Array([104, 101, 108, 108, 111]);
    try {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      fetchMock
        .mockResolvedValueOnce(
          manifest([
            { id: "dlv_log", name: "verifier-log", kind: "artifact", status: "ready", media_type: "text/plain", display_filename: "verifier.log", size_bytes: payload.length, sha256: "a".repeat(64), download_url: "/x/dlv_log" },
          ]),
        )
        .mockResolvedValueOnce(
          new Response(payload, {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          }),
        );

      const code = await run([
        FULL_ID, "verifier-log", "--output", outPath, "--backend", "http://backend.test",
      ]);

      expect(code).toBe(0);
      expect(readFileSync(outPath)).toEqual(Buffer.from(payload));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits a JSON manifest with --json", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      manifest([
        { id: "dlv_1", name: "memorandum", kind: "json", status: "ready", media_type: "application/json", display_filename: null, size_bytes: 5, sha256: "a".repeat(64), download_url: "/x/dlv_1" },
      ]),
    );
    const { logs, restore } = captureLog();

    const code = await run([FULL_ID, "--backend", "http://backend.test", "--json"]);
    restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed[0].name).toBe("memorandum");
    expect(parsed[0].kind).toBe("json");
  });
});
