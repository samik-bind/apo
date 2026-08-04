#!/usr/bin/env node
// @apo-ai/cli clean-consumer package gate.
//
// Packs the CLI exactly as a registry release would, installs it into a
// clean directory, and verifies the binary runs. Never publishes.
//
// Run with:
//   pnpm --filter @apo-ai/cli package:check

import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(PKG_DIR, "..", "..");

function fail(message) {
  console.error(`\n  ✖ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function step(label) {
  console.log(`\n ▸ ${label}`);
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur)) {
      const full = join(cur, entry);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out;
}

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "apo-cli-verify-"));
  console.log(`  temp dir: ${dir}`);
  return dir;
}

function packCli(tempDir) {
  step("Build + pack CLI tarball (prepack runs the build)");
  const output = run("pnpm", ["pack", "--pack-destination", tempDir], {
    cwd: PKG_DIR,
  });
  const match = output.match(/([^\s]+\.tgz)\s*$/);
  if (!match) fail(`pnpm pack did not report a .tgz path:\n${output}`);
  const tarball = match[1];
  const absTarball = existsSync(tarball) ? tarball : join(tempDir, tarball);
  if (!existsSync(absTarball)) fail(`packed tarball not found: ${absTarball}`);
  const sizeKb = Math.round(statSync(absTarball).size / 1024);
  console.log(`  tarball:      ${absTarball}`);
  console.log(`  compressed:   ${sizeKb} KB`);
  return { tarball: absTarball, sizeKb };
}

function installTarball(tempDir, tarball) {
  step("Install tarball into a clean npm consumer");
  const consumerDir = join(tempDir, "consumer");
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "apo-cli-smoke", private: true }, null, 2) + "\n",
  );
  run(
    "npm",
    ["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: consumerDir },
  );
  const installedPkgDir = join(consumerDir, "node_modules", "@apo-ai", "cli");
  if (!existsSync(installedPkgDir)) fail(`installed package missing at ${installedPkgDir}`);
  console.log(`  installed:    ${installedPkgDir}`);
  return { consumerDir, installedPkgDir };
}

function verifyManifest(installedPkgDir, sourceManifest) {
  step("Verify installed package.json");
  const installed = readJson(join(installedPkgDir, "package.json"));
  if (installed.name !== sourceManifest.name) fail(`name mismatch`);
  if (installed.version !== sourceManifest.version) fail(`version mismatch`);
  if (installed.bin?.apo !== "./dist/main.js") fail(`bin.apo should point at dist/main.js`);
  console.log(`  name:         ${installed.name}`);
  console.log(`  version:      ${installed.version}`);
  console.log(`  bin:          ${installed.bin.apo}`);
}

function verifyNoSourceShipped(installedPkgDir) {
  step("Verify no raw TypeScript source ships");
  const files = walkFiles(installedPkgDir);
  const offenders = files.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  if (offenders.length > 0) {
    fail(`raw .ts source shipped:\n  ${offenders.map((f) => relative(installedPkgDir, f)).join("\n  ")}`);
  }
  console.log(`  shipped:      ${files.length} files (no raw .ts)`);
  return { fileCount: files.length };
}

function verifyLicense(installedPkgDir) {
  step("Verify LICENSE + README");
  for (const name of ["LICENSE", "README.md"]) {
    const path = join(installedPkgDir, name);
    if (!existsSync(path)) fail(`missing ${name}`);
  }
  const rootLicense = readFileSync(join(REPO_ROOT, "LICENSE"), "utf8");
  const local = readFileSync(join(installedPkgDir, "LICENSE"), "utf8");
  if (local.trim() !== rootLicense.trim()) fail("LICENSE text mismatch");
  console.log("  LICENSE:      matches repository root");
  console.log("  README.md:    present");
}

function verifyBinaryRuns(consumerDir, installedPkgDir, sourceVersion) {
  step("Verify the installed binary runs");
  // Run via node directly — `npx apo` would be shadowed by a system `apo`
  // binary on PATH (e.g. ~/.local/bin/apo from a monorepo dev install).
  const binPath = join(installedPkgDir, "dist", "main.js");
  try {
    const out = run("node", [binPath, "--version"], { cwd: consumerDir });
    if (!out.includes(sourceVersion)) fail(`apo --version returned unexpected output: ${out}`);
    console.log(`  apo --version: ${out.trim()}`);
  } catch (err) {
    fail(`binary failed to run: ${err.message}`);
  }
}

function verifyPublint(installedPkgDir, consumerDir) {
  step("Run publint against installed package");
  run("npm", ["install", "publint", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: consumerDir,
  });
  try {
    run("npx", ["publint", "--strict", installedPkgDir], { cwd: consumerDir });
    console.log("  publint:      zero errors");
  } catch (err) {
    fail(`publint reported issues:\n${err.stdout || err.message}`);
  }
}

function main() {
  const sourceManifest = readJson(join(PKG_DIR, "package.json"));
  const sourceVersion = sourceManifest.version;
  console.log(`Verifying @apo-ai/cli@${sourceVersion} from ${PKG_DIR}`);

  const tempDir = createTempDir();
  let summary = null;
  try {
    const { tarball, sizeKb } = packCli(tempDir);
    const { consumerDir, installedPkgDir } = installTarball(tempDir, tarball);
    verifyManifest(installedPkgDir, sourceManifest);
    const { fileCount } = verifyNoSourceShipped(installedPkgDir);
    verifyLicense(installedPkgDir);
    verifyBinaryRuns(consumerDir, installedPkgDir, sourceVersion);
    verifyPublint(installedPkgDir, consumerDir);
    summary = { version: sourceVersion, compressedKb: sizeKb, files: fileCount };
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      console.log(`\n ▸ cleaned temp dir`);
    } catch (err) {
      console.error(`  warning: could not remove temp dir: ${err.message}`);
    }
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.error("\n✖ package:check FAILED");
    process.exit(process.exitCode);
  }

  console.log(`\n✓ @apo-ai/cli@${summary.version} verified`);
  console.log(`  tarball:    ${summary.compressedKb} KB compressed`);
  console.log(`  files:      ${summary.files} in installed package`);
  console.log(`  binary:     apo --version runs cleanly`);
}

main();
