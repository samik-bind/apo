/**
 * file Artifact declaration helper.
 *
 * A ``FileArtifact`` is a path descriptor that identifies a regular local
 * file at persistence time. The SDK streams it to the backend (two-phase
 * upload) rather than buffering bytes in the result body.
 *
 * Rules:
 * - ``path`` must identify a regular local file at persistence time;
 * - directories, sockets, devices, and symbolic links are rejected;
 * - the default display filename is ``basename(path)``;
 * - the default media type is ``application/octet-stream``;
 * - ``t.judge(fileArtifact(...))`` is rejected: a path descriptor is not file
 *   content. Authors must explicitly read/parse the content to judge it.
 */

import { basename } from "node:path";
import { lstatSync, statSync } from "node:fs";

export interface FileArtifact {
  readonly kind: "apo.file-artifact";
  readonly path: string;
  readonly mediaType: string;
  readonly displayFilename: string;
}

export interface FileArtifactOptions {
  readonly mediaType?: string;
  readonly displayFilename?: string;
}

const DEFAULT_MEDIA_TYPE = "application/octet-stream";

/**
 * Declare a file Deliverable from a local file path.
 *
 * Validates eagerly that ``path`` points to an existing regular file (not a
 * directory, symlink, socket, or device) so authors get an actionable error
 * before the backend creates an upload intent.
 */
export function fileArtifact(
  path: string,
  options: FileArtifactOptions = {},
): FileArtifact {
  if (!path) {
    throw new Error("fileArtifact: path must not be empty");
  }
  // lstat does not follow symlinks; a symlink must be rejected even when its
  // target is a regular file.
  let stat;
  try {
    const lstat = lstatSync(path);
    if (lstat.isSymbolicLink()) {
      throw new Error("fileArtifact: path is a symbolic link, not a regular file");
    }
    stat = statSync(path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("fileArtifact:")) throw error;
    throw new Error("fileArtifact: path is not a regular file or is inaccessible");
  }
  if (!stat.isFile()) {
    throw new Error("fileArtifact: path is not a regular file");
  }

  const displayFilename = options.displayFilename ?? basename(path);
  if (!displayFilename) {
    throw new Error("fileArtifact: displayFilename must not be empty");
  }

  return Object.freeze({
    kind: "apo.file-artifact",
    path,
    mediaType: options.mediaType ?? DEFAULT_MEDIA_TYPE,
    displayFilename,
  });
}

export function isFileArtifact(value: unknown): value is FileArtifact {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "apo.file-artifact" &&
    typeof (value as { path?: unknown }).path === "string"
  );
}
