import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileArtifact, isFileArtifact } from "../src/agent-task/deliverables/artifact.ts";

describe("fileArtifact helper", () => {
  it("creates an artifact descriptor from a regular file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      const path = join(dir, "verifier.log");
      writeFileSync(path, "hello");
      const artifact = fileArtifact(path);
      expect(artifact.kind).toBe("apo.file-artifact");
      expect(artifact.path).toBe(path);
      expect(artifact.mediaType).toBe("application/octet-stream");
      expect(artifact.displayFilename).toBe("verifier.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors explicit mediaType and displayFilename", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      const path = join(dir, "out.json");
      writeFileSync(path, "{}");
      const artifact = fileArtifact(path, {
        mediaType: "application/json",
        displayFilename: "renamed.json",
      });
      expect(artifact.mediaType).toBe("application/json");
      expect(artifact.displayFilename).toBe("renamed.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isFileArtifact narrows apo.file-artifact values", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      const path = join(dir, "f.txt");
      writeFileSync(path, "x");
      const artifact = fileArtifact(path);
      expect(isFileArtifact(artifact)).toBe(true);
      expect(isFileArtifact({ kind: "other", path })).toBe(false);
      expect(isFileArtifact({ path })).toBe(false);
      expect(isFileArtifact(null)).toBe(false);
      expect(isFileArtifact("string")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing file", () => {
    expect(() => fileArtifact(join(tmpdir(), "does-not-exist-12345"))).toThrow(
      /not a regular file/,
    );
  });

  it("rejects a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      expect(() => fileArtifact(dir)).toThrow(/not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a symbolic link", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      const target = join(dir, "real.txt");
      writeFileSync(target, "x");
      const link = join(dir, "link.txt");
      symlinkSync(target, link);
      expect(() => fileArtifact(link)).toThrow(/not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects empty display filename override", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      const path = join(dir, "f.txt");
      writeFileSync(path, "x");
      expect(() => fileArtifact(path, { displayFilename: "" })).toThrow(
        /displayFilename/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default display filename is basename even with subdirectories", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-"));
    try {
      const nested = join(dir, "nested");
      mkdirSync(nested);
      const path = join(nested, "deep.log");
      writeFileSync(path, "x");
      const artifact = fileArtifact(path);
      expect(artifact.displayFilename).toBe("deep.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
