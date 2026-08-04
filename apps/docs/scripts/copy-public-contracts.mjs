/**
 * copy-public-contracts.mjs — publish canonical versioned schemas into dist.
 *
 * Copies the Task Revision v1 JSON Schemas from contracts/ into the Astro
 * build output so their `$id` URLs resolve on the public docs origin:
 *
 *   contracts/task-revision/v1/manifest.schema.json
 *     → dist/specs/contracts/task-revision/v1/manifest.schema.json
 *
 * The source schemas already carry resolvable `$id` values under the public
 * docs origin (see astro.config.mjs `site`), so this is a verbatim copy — no
 * rewriting, no new dependency.
 *
 * Run after `astro build`, before verify-publication.mjs.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
const repoRoot = join(docsRoot, "..", "..");
const distDir = join(docsRoot, "dist");

const SOURCES = [
  ["contracts/task-revision/v1/manifest.schema.json", "specs/contracts/task-revision/v1/manifest.schema.json"],
  ["contracts/task-revision/v1/case.schema.json", "specs/contracts/task-revision/v1/case.schema.json"],
];

for (const [relSource, relDest] of SOURCES) {
  const src = join(repoRoot, relSource);
  const dest = join(distDir, relDest);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copied ${relSource} → dist/${relDest}`);
}
