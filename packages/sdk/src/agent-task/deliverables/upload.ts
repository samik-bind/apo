/**
 * SPEC-140 ticket 05: file Artifact uploader.
 *
 * After checks run against the original in-memory Deliverables, this module
 * partitions JSON values from file Artifacts, streams each file to the
 * backend's two-phase upload endpoint, and returns only JSON Deliverables for
 * the final result body. File bytes never travel through the result request
 * or subprocess stdout.
 *
 * Storage failure does not flip a failed test into a pass: it raises, so the
 * caller records the run as errored.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";

import { isFileArtifact, type FileArtifact } from "./artifact.ts";

export interface DeliverableSummary {
  id: string;
  name: string;
  kind: "json" | "artifact";
  status: "pending" | "ready" | "failed";
  media_type: string;
  display_filename: string | null;
  size_bytes: number;
  sha256: string;
  download_url: string | null;
}

export interface ArtifactUploadIntent {
  id: string;
  upload_url: string;
}

export interface ArtifactUploadConfig {
  /** The Task Run id owning these Deliverables. */
  taskRunId: string;
  /** Bearer token (service token or API key) authorizing the upload. */
  authToken: string;
  /** Backend base URL, e.g. ``http://127.0.0.1:8000``. */
  baseUrl: string;
  /** Injectable fetch (tests pass a stub); defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface PreparedTaskResult {
  /** JSON-only deliverables safe to send in the final result body. */
  jsonDeliverables: Record<string, unknown>;
  /** Successfully uploaded file Artifacts (summaries only, no bodies). */
  artifactUploads: DeliverableSummary[];
}

const DEFAULT_FETCH: typeof fetch | undefined =
  typeof fetch === "function" ? fetch : undefined;

/**
 * Partition and persist Deliverables after checks complete.
 *
 * - file Artifacts are streamed to the backend (hash, create intent, PUT);
 * - JSON values are returned untouched for the result body;
 * - the local path of any Artifact is never embedded in the result.
 */
export async function persistFileArtifacts(
  deliverables: Record<string, unknown>,
  config: ArtifactUploadConfig,
): Promise<PreparedTaskResult> {
  const jsonDeliverables: Record<string, unknown> = {};
  const artifactUploads: DeliverableSummary[] = [];

  for (const [name, value] of Object.entries(deliverables)) {
    if (isFileArtifact(value)) {
      const summary = await uploadOne(name, value, config);
      artifactUploads.push(summary);
    } else {
      jsonDeliverables[name] = value;
    }
  }

  return { jsonDeliverables, artifactUploads };
}

async function uploadOne(
  name: string,
  artifact: FileArtifact,
  config: ArtifactUploadConfig,
): Promise<DeliverableSummary> {
  const { size, sha256 } = await hashFile(artifact.path);
  const intent = await createIntent(name, artifact, size, sha256, config);

  const body = Readable.toWeb(createReadStream(artifact.path)) as ReadableStream<Uint8Array>;
  const summary = await putBytes(intent.upload_url, body, size, config);
  // The local filename never enters the persisted summary; the server owns
  // display metadata through the intent.
  void basename;
  return summary;
}

async function hashFile(
  path: string,
): Promise<{ size: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let size = 0;
    const stream = createReadStream(path);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });
    stream.on("error", reject);
    stream.on("end", () => resolve({ size, sha256: hash.digest("hex") }));
  });
}

async function createIntent(
  name: string,
  artifact: FileArtifact,
  sizeBytes: number,
  sha256: string,
  config: ArtifactUploadConfig,
): Promise<ArtifactUploadIntent> {
  const url = `${config.baseUrl}/v1/agent-task-runs/${config.taskRunId}/artifact-uploads`;
  const response = await doFetch(config, url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      display_filename: artifact.displayFilename,
      media_type: artifact.mediaType,
      size_bytes: sizeBytes,
      sha256,
    }),
  });
  if (response.status === 201) {
    const body = (await response.json()) as ArtifactUploadIntent;
    return body;
  }
  const detail = await safeDetail(response);
  throw new Error(
    `artifact upload intent for '${name}' failed (${response.status}): ${detail}`,
  );
}

async function putBytes(
  uploadUrl: string,
  body: ReadableStream<Uint8Array>,
  sizeBytes: number,
  config: ArtifactUploadConfig,
): Promise<DeliverableSummary> {
  const url = uploadUrl.startsWith("http")
    ? uploadUrl
    : `${config.baseUrl}${uploadUrl}`;
  const response = await doFetch(config, url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.authToken}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(sizeBytes),
    },
    body,
    duplex: "half",
  } as RequestInit);
  if (response.status === 200) {
    return (await response.json()) as DeliverableSummary;
  }
  const detail = await safeDetail(response);
  throw new Error(
    `artifact upload of ${sizeBytes} bytes failed (${response.status}): ${detail}`,
  );
}

async function doFetch(
  config: ArtifactUploadConfig,
  input: string,
  init: RequestInit,
): Promise<Response> {
  const fetchImpl = config.fetch ?? DEFAULT_FETCH;
  if (!fetchImpl) {
    throw new Error("persistFileArtifacts: fetch is not available in this environment");
  }
  return fetchImpl(input, init);
}

async function safeDetail(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "<no body>";
  }
}
