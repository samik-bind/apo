/**
 * Harbor evidence is a durable file Artifact, and no
 * absolute host path enters the persisted manifest.
 *
 * The Harbor adapter now declares `harbor_result` as a `fileArtifact` instead
 * of the old `harbor_artifacts` path-strings deliverable. When the SDK
 * partitions deliverables, the local path stays out of the JSON result body.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileArtifact, isFileArtifact, persistFileArtifacts } from "@apo/sdk/agent-task";

const FIXTURE = join(
  import.meta.dirname,
  "fixtures/harbor/pass/result.json",
);

describe("harbor deliverables — no host path leaks", () => {
  it("harbor_result is a file artifact, not a path string", () => {
    // Mirror what harbor-adapter.ts produces: fileArtifact(resultPath).
    const artifact = fileArtifact(FIXTURE, {
      mediaType: "application/json",
      displayFilename: "result.json",
    });
    expect(isFileArtifact(artifact)).toBe(true);
    expect(artifact.displayFilename).toBe("result.json");
    expect(artifact.mediaType).toBe("application/json");
  });

  it("the local result path never enters the persisted manifest", async () => {
    // A real harbor run writes result.json into a per-job dir; simulate that.
    const jobDir = mkdtempSync(join(tmpdir(), "harbor-job-"));
    const resultPath = join(jobDir, "result.json");
    writeFileSync(resultPath, '{"verifier_result":{"rewards":{"reward":1}}}');

    try {
      const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: "upl_1",
              upload_url: "/v1/agent-task-artifact-uploads/upl_1",
            }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({ id: "dlv_1", name: "harbor_result", kind: "artifact", status: "ready", media_type: "application/json", display_filename: "result.json", size_bytes: 1, sha256: "a".repeat(64), download_url: null }),
          { status: 200 },
        );
      });

      const prepared = await persistFileArtifacts(
        {
          official_verdict: { benchmark: "terminal-bench", reward: 1 },
          harbor_trial: { job_name: "apo-1", status: "pass" },
          harbor_result: fileArtifact(resultPath, {
            mediaType: "application/json",
            displayFilename: "result.json",
          }),
        },
        { taskRunId: "run-1", authToken: "tok", baseUrl: "http://apo.test", fetch: fakeFetch },
      );

      // JSON deliverables carry provenance only — no host paths.
      const dumped = JSON.stringify(prepared);
      expect(dumped).not.toContain(jobDir);
      expect(dumped).not.toContain(resultPath);
      expect(dumped).not.toContain(dirname(resultPath));
      // The artifact was uploaded and recorded as a summary, not a path.
      expect(prepared.artifactUploads).toHaveLength(1);
      expect(prepared.artifactUploads[0].name).toBe("harbor_result");
      expect(prepared.jsonDeliverables.official_verdict).toEqual({
        benchmark: "terminal-bench",
        reward: 1,
      });
    } finally {
      rmSync(jobDir, { recursive: true, force: true });
    }
  });
});
