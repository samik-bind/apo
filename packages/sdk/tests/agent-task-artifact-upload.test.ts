import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  persistFileArtifacts,
  type ArtifactUploadConfig,
  type DeliverableSummary,
} from "../src/agent-task/deliverables/upload.ts";
import { fileArtifact } from "../src/agent-task/deliverables/artifact.ts";

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const SUMMARY: DeliverableSummary = {
  id: "dlv_1",
  name: "log",
  kind: "artifact",
  status: "ready",
  media_type: "text/plain",
  display_filename: "verifier.log",
  size_bytes: 5,
  sha256: sha256("hello"),
  download_url: "/v1/agent-task-runs/run-1/deliverables/dlv_1",
};

function makeConfig(fetchImpl: typeof fetch): ArtifactUploadConfig {
  return {
    taskRunId: "run-1",
    authToken: "tok",
    baseUrl: "http://apo.test",
    fetch: fetchImpl,
  };
}

describe("persistFileArtifacts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "upload-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("partitions JSON and file deliverables, uploading only files", async () => {
    const logPath = join(dir, "verifier.log");
    writeFileSync(logPath, "hello");
    const artifact = fileArtifact(logPath, { mediaType: "text/plain" });

    const calls: string[] = [];
    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/artifact-uploads") && init?.method === "POST") {
        calls.push("intent");
        return new Response(JSON.stringify({ id: "upl_1", upload_url: "/v1/agent-task-artifact-uploads/upl_1" }), {
          status: 201,
        });
      }
      if (url.includes("/agent-task-artifact-uploads/") && init?.method === "PUT") {
        calls.push("upload");
        return new Response(JSON.stringify(SUMMARY), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await persistFileArtifacts(
      {
        verdict: { reward: 1 },
        log: artifact,
      },
      makeConfig(fakeFetch),
    );

    expect(result.jsonDeliverables).toEqual({ verdict: { reward: 1 } });
    expect(result.artifactUploads).toHaveLength(1);
    expect(result.artifactUploads[0].name).toBe("log");
    expect(calls).toEqual(["intent", "upload"]);
  });

  it("streams the exact file bytes via PUT", async () => {
    const data = Buffer.from("the quick brown fox");
    const logPath = join(dir, "log.txt");
    writeFileSync(logPath, data);
    const artifact = fileArtifact(logPath);

    const seenBody: Buffer[] = [];
    const fakeFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ id: "upl_1", upload_url: "/v1/agent-task-artifact-uploads/upl_1" }),
          { status: 201 },
        );
      }
      if (init?.method === "PUT") {
        const reader = (init.body as ReadableStream).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          seenBody.push(Buffer.from(value));
        }
        return new Response(JSON.stringify(SUMMARY), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    await persistFileArtifacts({ log: artifact }, makeConfig(fakeFetch));
    expect(Buffer.concat(seenBody)).toEqual(data);
  });

  it("does not upload JSON deliverables", async () => {
    const fakeFetch = vi.fn(async () => new Response("", { status: 404 }));
    const result = await persistFileArtifacts(
      { a: 1, b: "two", c: [1, 2, 3], d: { nested: true } },
      makeConfig(fakeFetch),
    );
    expect(Object.keys(result.jsonDeliverables).sort()).toEqual(["a", "b", "c", "d"]);
    expect(result.artifactUploads).toEqual([]);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("reuses an existing intent when metadata matches (idempotent)", async () => {
    const logPath = join(dir, "log.txt");
    writeFileSync(logPath, "abc");
    const artifact = fileArtifact(logPath);

    const fakeFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        // Second intent call returns the same id — idempotent.
        return new Response(
          JSON.stringify({ id: "upl_same", upload_url: "/v1/agent-task-artifact-uploads/upl_same" }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify(SUMMARY), { status: 200 });
    });

    const result = await persistFileArtifacts({ log: artifact }, makeConfig(fakeFetch));
    expect(result.artifactUploads[0].name).toBe("log");
  });

  it("rejects judge() over a file artifact path (not file content)", async () => {
    // fileArtifact is a path descriptor; it must not be usable as a judge
    // received value. The partition step leaves artifacts out of JSON.
    const logPath = join(dir, "log.txt");
    writeFileSync(logPath, "abc");
    const artifact = fileArtifact(logPath);

    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ id: "upl_1", upload_url: "/v1/agent-task-artifact-uploads/upl_1" }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify(SUMMARY), { status: 200 });
    });

    const result = await persistFileArtifacts({ log: artifact }, makeConfig(fakeFetch));
    // The artifact is uploaded, not retained as a JSON value to be judged.
    expect(result.jsonDeliverables.log).toBeUndefined();
  });

  it("throws when intent creation fails", async () => {
    const logPath = join(dir, "log.txt");
    writeFileSync(logPath, "abc");
    const artifact = fileArtifact(logPath);

    const fakeFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ detail: "conflicting" }), { status: 409 });
      }
      return new Response("", { status: 404 });
    });

    await expect(
      persistFileArtifacts({ log: artifact }, makeConfig(fakeFetch)),
    ).rejects.toThrow(/artifact upload intent/);
  });

  it("reports the upload URL opaque and never embeds the local path", async () => {
    const logPath = join(dir, "secret-name.log");
    writeFileSync(logPath, "x");
    const artifact = fileArtifact(logPath);

    const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ id: "upl_1", upload_url: "/v1/agent-task-artifact-uploads/upl_1" }),
          { status: 201 },
        );
      }
      if (url.includes("/agent-task-artifact-uploads/")) {
        return new Response(JSON.stringify(SUMMARY), { status: 200 });
      }
      return new Response("", { status: 404 });
    });

    const result = await persistFileArtifacts({ log: artifact }, makeConfig(fakeFetch));
    const dumped = JSON.stringify(result);
    // The local absolute path never enters the persisted result.
    expect(dumped).not.toContain(logPath);
    expect(dumped).not.toContain("secret-name.log");
  });

  // SPEC-172 SDK test #4: JSON-only runs need no upload context at all.
  it("passes JSON-only deliverables through without upload context", async () => {
    const failFetch = vi.fn(async () => {
      throw new Error("fetch should not be called for JSON-only deliverables");
    });
    const result = await persistFileArtifacts(
      { score: { value: 0.92 } },
      { taskRunId: "", authToken: "", baseUrl: "", fetch: failFetch },
    );
    expect(result.jsonDeliverables).toEqual({ score: { value: 0.92 } });
    expect(result.artifactUploads).toEqual([]);
    expect(failFetch).not.toHaveBeenCalled();
  });

  // SPEC-172 SDK test #5: missing Artifact context fails safely before any request.
  it("fails safely when Artifact context is missing (no request, no path leak)", async () => {
    const logPath = join(dir, "secret-path.log");
    writeFileSync(logPath, "data");
    const artifact = fileArtifact(logPath);

    const failFetch = vi.fn(async () => {
      throw new Error("fetch should not be called when context is missing");
    });

    const error = await persistFileArtifacts(
      { report: artifact },
      { taskRunId: "", authToken: "", baseUrl: "", fetch: failFetch },
    ).then(
      () => null,
      (e: Error) => e,
    );

    expect(error).not.toBeNull();
    expect(failFetch).not.toHaveBeenCalled();
    // Names the Deliverable so the author knows which one failed.
    expect(error!.message).toContain("report");
    // Never leaks the executor-local path.
    expect(error!.message).not.toContain(logPath);
  });
});
