/**
 * verify-self-adoption.mjs — reject placeholder URLs, retired commands, and
 * retired executor topology in current-state onboarding/operator pages.
 *
 * Scans source entry files and built artifacts for patterns that contradict
 * the current first-run path. Specs, ADRs, and migration history are excluded.
 *
 * Run as part of `pnpm --filter docs build` after Astro + publication verify.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const docsRoot = join(here, "..");
const repoRoot = join(docsRoot, "..", "..");

// ── Scan roots (current-state docs only — specs/ADRs/migration excluded) ──
const SCAN_DIRS = [
  join(docsRoot, "src/content/docs"),
  join(docsRoot, "src/pages"),
  join(repoRoot, "README.md"),
  join(repoRoot, "packages/cli/README.md"),
  join(docsRoot, "README.md"),
  join(repoRoot, "docs/self-hosted-alpha.md"),
  join(repoRoot, "docs/architecture.md"),
  join(repoRoot, "docs/development.md"),
].map((p) => p.replace(/\/$/, ""));

// ── Banned patterns ──
const BANNED = [
  // Placeholder URLs
  { pattern: /git clone <repo-url>/, reason: "placeholder repo URL" },
  // Retired CLI commands (whole families)
  { pattern: /apo project source\b/, reason: "retired command family 'apo project source'" },
  { pattern: /apo project init-tasks/, reason: "retired command 'apo project init-tasks'" },
  { pattern: /apo project sync-tasks/, reason: "retired command 'apo project sync-tasks'" },
  { pattern: /apo batch create/, reason: "retired command 'apo batch create'" },
  // Retired executor topology (current-state pages only)
  { pattern: /\bBundled\s+Executor\b/, reason: "retired 'Bundled Executor' topology" },
  { pattern: /APO_BUNDLED_EXECUTOR_ENABLED/, reason: "retired executor variable" },
  { pattern: /apo_executor_bootstrap/, reason: "retired executor bootstrap" },
  { pattern: /apo_executor_state/, reason: "retired executor state" },
  { pattern: /task_source_cache/, reason: "retired task source cache" },
];

// ── Helpers ──
function walkFiles(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    if (statSync(full).isDirectory()) return walkFiles(full);
    return [full];
  });
}

function isScannable(path) {
  const ext = extname(path);
  return [".md", ".mdx", ".ts", ".astro"].includes(ext);
}

// ── Scan ──
let failures = 0;

for (const scanPath of SCAN_DIRS) {
  if (!existsSync(scanPath)) continue;
  const files = walkFiles(scanPath).filter(isScannable);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const { pattern, reason } of BANNED) {
      if (pattern.test(text)) {
        const rel = relative(repoRoot, file);
        console.error(`self-adoption verify: FAIL`);
        console.error(`  ${reason} found in ${rel}`);
        failures++;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\nself-adoption verify: ${failures} violation(s)`);
  process.exit(1);
}

console.log("self-adoption verify: ok");
process.exit(0);
