// Documentation contract: the hosted onboarding path must stay
// truthful. This verifier fails when hosted copy tells adopters to
// self-host first, leaks localhost/internal hostnames into hosted
// commands, suggests `apo project create` after admission, or drifts
// from the self-host Quickstart / generated /start.md routing.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS = join(__dirname, "..", "src", "content", "docs");
const REPO = join(__dirname, "..", "..", "..");

const failures = [];

function check(name, condition, detail = "") {
  if (!condition) failures.push(detail ? `${name}: ${detail}` : name);
}

function read(relPath) {
  const abs = join(DOCS, relPath);
  if (!existsSync(abs)) {
    failures.push(`missing file: ${relPath}`);
    return "";
  }
  return readFileSync(abs, "utf8");
}

const hosted = read("hosted-alpha.mdx");
const quickstart = read("quickstart.mdx");
const startMd = readFileSync(join(REPO, "apps/docs/src/pages/start.md.ts"), "utf8");
const startHere = readFileSync(
  join(
    REPO,
    "apps/example-service/e2e/agent-task-demo/START-HERE.md",
  ),
  "utf8",
);
const astroConfig = readFileSync(join(REPO, "apps/docs/astro.config.mjs"), "utf8");

// 1. Hosted onboarding never tells the adopter to self-host first.
check(
  "hosted-alpha must not instruct self-hosting",
  !/git clone[\s\S]{0,120}self-host|scripts\/self-host|docker compose up/i.test(hosted),
);

// 2. Hosted commands never contain localhost or internal compose hostnames.
//    (The localhost mention that IS allowed: none in command fences.)
const hostedFences = [...hosted.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
for (const [i, fence] of hostedFences.entries()) {
  check(
    `hosted-alpha fence #${i + 1} must not contain localhost/internal hosts`,
    !/localhost|backend:8000|127\.0\.0\.1/.test(fence),
    fence.split("\n")[0],
  );
}

// 3. Admission already created the Project — never `apo project create`.
check(
  "hosted-alpha must not use `apo project create`",
  !/apo project create/.test(hosted),
);

// 4. Machine instructions use exact run identity, never bare latest lookup.
check(
  "hosted-alpha must not use bare `apo runs show` without an id",
  !/apo runs show(\s|$|`)(?![^`]*run_)/.test(hosted) ||
    !/`apo runs show`/.test(hosted),
);
check(
  "hosted-alpha must print exact run identity in examples",
  /runs show run_/.test(hosted),
);

// 5. Docs must not imply source or provider secrets are uploaded.
check(
  "hosted-alpha must not imply uploading source/secrets",
  !/upload(s|ing)? (your )?(source|repository|secrets|provider)/i.test(hosted),
);

// 6. Routing consistency: quickstart forks to hosted, start.md routes
//    invited agents to hosted-alpha, sidebar links it.
check(
  "quickstart must fork hosted adopters to Hosted Alpha",
  quickstart.includes("/hosted-alpha/"),
);
check(
  "generated /start.md must route invited users to hosted-alpha",
  startMd.includes("hosted-alpha"),
);
check(
  "sidebar must include Hosted Alpha",
  astroConfig.includes("hosted-alpha"),
);
check(
  "START-HERE must offer the hosted control-plane case",
  /invited to a hosted apo/i.test(startHere),
);

// 7. Example paths in the dashboard onboarding component match the
//    maintained example.
const firstRun = readFileSync(
  join(
    REPO,
    "apps/dashboard/src/lib/first-run.ts",
  ),
  "utf8",
);
check(
  "dashboard EXAMPLE_URL must point at the maintained example",
  firstRun.includes("apps/example-service/e2e/agent-task-demo"),
);
check(
  "dashboard docs link must be the canonical absolute hosted-alpha URL",
  firstRun.includes('"https://docs.test-apo.online/hosted-alpha/"'),
);

if (failures.length > 0) {
  console.error("Docs contract violations:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("Docs contract: ok");
