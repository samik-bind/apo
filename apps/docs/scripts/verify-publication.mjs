/**
 * verify-publication.mjs — fail the build on publication drift.
 *
 * Runs after `astro build` + schema publication and asserts the five
 * publication invariants:
 *
 *   1. No built artifact references the retired origin (https://apo.dev).
 *   2. Every same-origin absolute URL in start.md resolves to a built file.
 *   3. The two stale slugs are gone; the canonical slugs are present.
 *   4. The landing-page Copy Prompt points at the live origin, not apo.dev
 *      or localhost.
 *   5. The published schema `$id`s map to their exact built path on the
 *      public docs origin, and the file is byte-for-byte the source schema.
 *
 * Uses only Node built-ins — no new dependency.
 *
 * Usage: node apps/docs/scripts/verify-publication.mjs [distDir]
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
const repoRoot = join(docsRoot, "..", "..");

const DOCS_ORIGIN = "https://docs.test-apo.online";
const RETIRED_ORIGIN = "https://apo.dev";

const distDir = process.argv[2]
  ? join(process.cwd(), process.argv[2])
  : join(docsRoot, "dist");

// ---------------------------------------------------------------------------
// 1. Reject the retired origin anywhere in the built output.
// ---------------------------------------------------------------------------
function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

const allFiles = existsSync(distDir) ? walkFiles(distDir) : [];
if (allFiles.length === 0) {
  fail(`dist is empty or missing at ${distDir} — run the docs build first.`);
}

for (const file of allFiles) {
  // Binary assets (fonts, images) won't contain the origin string and are
  // skipped to avoid dumping binary into the error message.
  if (isBinaryExt(extname(file))) continue;
  const text = readFileSync(file, "utf8");
  if (text.includes(RETIRED_ORIGIN)) {
    fail(
      `retired origin "${RETIRED_ORIGIN}" found in ${relative(repoRoot, file)} ` +
        `— replace with the public docs origin.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Every same-origin absolute URL in start.md resolves to a built file.
// ---------------------------------------------------------------------------
const startMd = readFileSync(join(distDir, "start.md"), "utf8");
const sameOriginUrls = extractSameOriginPaths(startMd, DOCS_ORIGIN);

if (sameOriginUrls.length === 0) {
  fail(`start.md contains no ${DOCS_ORIGIN} URLs — Copy Prompt is broken.`);
}

for (const urlPath of sameOriginUrls) {
  if (!resolveArtifact(distDir, urlPath)) {
    fail(
      `start.md links ${DOCS_ORIGIN}${urlPath} but no built artifact ` +
        `resolves to it under ${relative(repoRoot, distDir)}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. The two stale slugs are gone; the canonical slugs are present.
// ---------------------------------------------------------------------------
const STALE = ["/reference/adapter-contract.md", "/sdk/tracing-integrations.md"];
const CANONICAL = ["/reference/adapter.md", "/reference/tracing-integrations.md"];

for (const stale of STALE) {
  if (startMd.includes(stale)) {
    fail(`start.md still references stale slug "${stale}".`);
  }
}
for (const good of CANONICAL) {
  if (!startMd.includes(good)) {
    fail(`start.md is missing canonical slug "${good}".`);
  }
}

// ---------------------------------------------------------------------------
// 4. The Copy Prompt on the landing page points at the live origin.
// ---------------------------------------------------------------------------
const indexHtml = readFileSync(join(distDir, "index.html"), "utf8");
const copyPromptUrl = `${DOCS_ORIGIN}/start.md`;
if (!indexHtml.includes(copyPromptUrl)) {
  fail(
    `landing page Copy Prompt does not reference ${copyPromptUrl}.`,
  );
}
if (indexHtml.includes(RETIRED_ORIGIN)) {
  fail(`landing page still references retired origin ${RETIRED_ORIGIN}.`);
}
if (indexHtml.includes("http://localhost:3000")) {
  fail(`landing page still sends visitors to http://localhost:3000.`);
}

// ---------------------------------------------------------------------------
// 5. Published schema $id values map to their exact built path.
// ---------------------------------------------------------------------------
const SCHEMA_MAP = [
  [
    "contracts/task-revision/v1/manifest.schema.json",
    "specs/contracts/task-revision/v1/manifest.schema.json",
  ],
  [
    "contracts/task-revision/v1/case.schema.json",
    "specs/contracts/task-revision/v1/case.schema.json",
  ],
];

for (const [relSource, relDest] of SCHEMA_MAP) {
  const dest = join(distDir, relDest);
  if (!existsSync(dest)) {
    fail(`schema artifact missing in dist: ${relDest}`);
  }
  const source = join(repoRoot, relSource);
  const sourceText = readFileSync(source, "utf8");
  const destText = readFileSync(dest, "utf8");
  if (sourceText !== destText) {
    fail(
      `published schema ${relDest} is not byte-for-byte its source ${relSource}.`,
    );
  }
  const sourceId = JSON.parse(sourceText).$id;
  const expectedId = `${DOCS_ORIGIN}/${relDest}`;
  if (sourceId !== expectedId) {
    fail(
      `schema ${relSource} $id is "${sourceId}" but must be "${expectedId}" ` +
        `to resolve on the public docs origin.`,
    );
  }
}

console.log("publication verify: ok");
process.exit(0);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function fail(message) {
  console.error(`publication verify: FAIL\n  ${message}`);
  process.exit(1);
}

function isBinaryExt(ext) {
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".svg",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
  ].includes(ext.toLowerCase());
}

/**
 * Extract same-origin absolute URL *paths* from markdown prose.
 *
 * Matches the docs origin followed by a path, stopping at whitespace, quotes,
 * and brackets, then trims trailing prose punctuation (`.,;:!?`) so a URL
 * immediately followed by a period/comma/parenthesis is parsed correctly.
 * Query strings and fragments are stripped before returning the path.
 */
function extractSameOriginPaths(markdown, origin) {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}([^\\s"'<>)\\]]*)`, "g");
  const paths = new Set();
  let match;
  while ((match = re.exec(markdown)) !== null) {
    let path = match[1].replace(/[?#].*$/, "").replace(/[.,;!?)]+$/, "");
    if (path === "") path = "/";
    paths.add(path);
  }
  return [...paths];
}

/**
 * Map a URL path to a built artifact in dist. Returns the resolved file or
 * null. Handles: exact files, `.md` routes, directory indexes, and the root.
 */
function resolveArtifact(dist, urlPath) {
  const clean = urlPath.replace(/\/+$/, "") || "/";
  // Exact file (e.g. /start.md, /reference/assertions.md, /cli.md).
  const exact = join(dist, clean);
  if (existsSync(exact) && statSync(exact).isFile()) return exact;
  // Directory index (e.g. /overview → /overview/index.html).
  const index = join(dist, clean === "/" ? "" : clean, "index.html");
  if (existsSync(index)) return index;
  // Root index.
  if (clean === "/" && existsSync(join(dist, "index.html"))) {
    return join(dist, "index.html");
  }
  return null;
}
