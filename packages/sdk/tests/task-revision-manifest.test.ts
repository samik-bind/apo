import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  buildManifest,
  canonicalManifestJson,
  contentSha256,
  type ManifestFileInput,
  type TaskRevisionManifestV1,
} from "../src/agent-task/task-revision-manifest.ts";

/**
 * Task Revision manifest canonicalizer — parity corpus.
 *
 * Each fixture under contracts/task-revision/v1/cases/ carries inputs
 * (path, modeClass, content) and an `expected.contentSha256` derived
 * independently from the canonical algorithm. The TypeScript canonicalizer
 * MUST reproduce the exact digest and summary for every case, byte-for-byte
 * with the Python implementation.
 *
 * (The corpus lives at the repo-root tracked `contracts/` dir rather than
 * under `specs/`, because the entire `specs/` tree is gitignored and a
 * corpus consumed by shipped tests must ship.)
 */

const casesDir = fileURLToPath(
  new URL("../../../contracts/task-revision/v1/cases", import.meta.url),
);

interface CaseFile {
  path: string;
  modeClass: "regular" | "executable";
  contentText?: string;
  contentHex?: string;
}
interface Case {
  name: string;
  description: string;
  files: CaseFile[];
  expected: { contentSha256: string; fileCount: number; uncompressedSizeBytes: number };
}

function loadCases(): Case[] {
  return readdirSync(casesDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(casesDir, f), "utf8")) as Case);
}

function decodeContent(c: CaseFile): Uint8Array {
  if (c.contentHex !== undefined) {
    const hex = c.contentHex;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  return new TextEncoder().encode(c.contentText ?? "");
}

function toInputs(c: Case): ManifestFileInput[] {
  return c.files.map((f) => ({
    path: f.path,
    modeClass: f.modeClass,
    content: decodeContent(f),
  }));
}

describe("task-revision-manifest (TypeScript)", () => {
  it.each(loadCases().map((c) => [c.name, c] as const))(
    "case %s reproduces the canonical digest and summary",
    (_name, c) => {
      const manifest = buildManifest(toInputs(c));
      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.summary.fileCount).toBe(c.expected.fileCount);
      expect(manifest.summary.uncompressedSizeBytes).toBe(c.expected.uncompressedSizeBytes);
      expect(contentSha256(manifest)).toBe(c.expected.contentSha256);
    },
  );

  it("files are sorted by bytewise UTF-8 of the normalized POSIX+NFC path", () => {
    const manifest = buildManifest(
      [
        { path: "apple.txt", modeClass: "regular", content: new TextEncoder().encode("a\n") },
        { path: "Zebra.txt", modeClass: "regular", content: new TextEncoder().encode("z\n") },
        { path: "éclair.txt", modeClass: "regular", content: new TextEncoder().encode("é\n") },
      ],
    );
    expect(manifest.files.map((f) => f.path)).toEqual(["Zebra.txt", "apple.txt", "éclair.txt"]);
  });

  it("normalizes backslash separators to POSIX", () => {
    const manifest = buildManifest([
      { path: ["src", "utils", "time.ts"].join(sep === "\\" ? "\\" : "/"), modeClass: "regular", content: new Uint8Array() },
    ]);
    expect(manifest.files[0]!.path).toBe("src/utils/time.ts");
  });

  it("canonical JSON is compact, ascii-false, sorted-keys, over schemaVersion+files only", () => {
    const manifest = buildManifest([
      { path: "README.md", modeClass: "regular", content: new TextEncoder().encode("hi\n") },
    ]);
    // Exactly the independently-derived canonical bytes; summary excluded.
    expect(canonicalManifestJson(manifest)).toBe(
      '{"files":[{"modeClass":"regular","path":"README.md","sha256":"98ea6e4f216f2fb4b69fff9b3a44842c38686ca685f3f55dc48c5d3fb1107be4","sizeBytes":3}],"schemaVersion":1}',
    );
  });

  it("exposes the V1 manifest type with zeroed exclusion counts by default", () => {
    const manifest: TaskRevisionManifestV1 = buildManifest([
      { path: "a.txt", modeClass: "regular", content: new Uint8Array() },
    ]);
    expect(manifest.summary.excludedFileCount).toBe(0);
    expect(manifest.summary.excludedDirectoryCount).toBe(0);
  });
});
