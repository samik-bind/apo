import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(__dirname, "..");
const REPO_ROOT = join(PKG_DIR, "..", "..");

interface CliPackageJson {
  name: string;
  version: string;
  description: string;
  type: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
  license?: string;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: { url?: string };
  publishConfig?: {
    access?: string;
    registry?: string;
  };
}

function readCliManifest(): CliPackageJson {
  return JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as CliPackageJson;
}

describe("@apo-ai/cli package manifest", () => {
  describe("public metadata", () => {
    const pkg = readCliManifest();

    it("is named @apo-ai/cli", () => {
      expect(pkg.name).toBe("@apo-ai/cli");
    });

    it("declares a non-empty description", () => {
      expect(typeof pkg.description).toBe("string");
      expect(pkg.description.length).toBeGreaterThan(10);
    });

    it("is ESM-only (type: module)", () => {
      expect(pkg.type).toBe("module");
    });

    it("declares bin pointing at compiled dist", () => {
      expect(pkg.bin?.apo).toBe("./dist/main.js");
    });

    it("ships dist, LICENSE, and README only", () => {
      expect(pkg.files).toEqual(
        expect.arrayContaining(["dist", "LICENSE", "README.md"]),
      );
    });

    it("requires Node >=20", () => {
      expect(pkg.engines?.node).toMatch(/>=\s*20/);
    });

    it("is MIT licensed", () => {
      expect(pkg.license).toBe("MIT");
    });

    it("declares the git repository with a packages/cli directory", () => {
      expect(pkg.repository?.type).toBe("git");
      expect(pkg.repository?.url).toContain("github.com");
      expect(pkg.repository?.directory).toBe("packages/cli");
    });
  });

  describe("publishConfig", () => {
    const pkg = readCliManifest();

    it("is present", () => {
      expect(pkg.publishConfig).toBeDefined();
    });

    it("is scoped public on the public npm registry", () => {
      expect(pkg.publishConfig?.access).toBe("public");
      expect(pkg.publishConfig?.registry).toBe("https://registry.npmjs.org/");
    });
  });

  describe("LICENSE inclusion", () => {
    it("ships a package-local LICENSE that matches the repo root LICENSE", () => {
      const root = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");
      const path = join(PKG_DIR, "LICENSE");
      if (!existsSync(path)) {
        throw new Error(`LICENSE missing at ${path}`);
      }
      const local = readFileSync(path, "utf8");
      expect(local.trim()).toBe(root.trim());
    });
  });
});
