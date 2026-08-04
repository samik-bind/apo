// Contract assertions for the public docs deployment overlay (SPEC-171 tests 7-9).
//
// Reads the rendered tunnel+docs Compose JSON plus the raw Caddyfile and
// cloudflared config, and asserts:
//   7. The docs service exists, is hardened, exposes only container port 8080,
//      and Caddy depends on its health.
//   8. Caddy routing is host-terminal: the docs host block precedes the app
//      block, proxies only to docs:8080, and skips Basic Auth; the app host
//      still reaches the auth fallback.
//   9. The Cloudflare Tunnel publishes both hostnames, docs first, terminal 404
//      last.
import { readFileSync } from "node:fs";

const DOCS_HOST = "docs.test-apo.online";
const APP_HOST = "test-apo.online";

const renderedPath = process.argv[2];
if (!renderedPath) {
  throw new Error(
    "usage: node tests/deployment/public-docs-contract.mjs <rendered-compose.json>",
  );
}
const rendered = JSON.parse(readFileSync(renderedPath, "utf8"));

// ---------------------------------------------------------------------------
// 7. Rendered deployment includes an isolated, hardened docs service.
// ---------------------------------------------------------------------------
const docs = rendered.services?.docs;
assert(docs, "public-docs overlay must define a 'docs' service");

assertNoHostPorts(docs, "docs service must expose no host ports");
assertContainerPort(docs, 8080, "docs service must expose container port 8080");

assert(
  docs.read_only === true,
  "docs service must be read_only: true",
);
assert(
  Array.isArray(docs.cap_drop) && docs.cap_drop.includes("ALL"),
  "docs service must cap_drop: [ALL]",
);
assert(
  Array.isArray(docs.security_opt) &&
    docs.security_opt.includes("no-new-privileges:true"),
  "docs service must set no-new-privileges:true",
);

// Caddy writes to /data and /config at startup; under read_only those need tmpfs.
assert(
  Array.isArray(docs.tmpfs) && docs.tmpfs.includes("/data"),
  "docs service must mount a writable tmpfs at /data for the read-only root",
);

assert(
  !docs.ports || docs.ports.length === 0,
  "docs service must publish no host ports",
);

// No source/repository mount — only the built dist is served.
const sourceMount = docs.volumes?.some(
  (v) =>
    typeof v === "string" &&
    (v.includes(":/app") || v.includes("repo") || v.includes(".env")),
);
assert(!sourceMount, "docs service must not mount repository source or .env");

// No application secrets leak into the docs container.
const docsEnv = docs.environment ?? {};
const SECRET_KEYS = [
  "AUTH_SECRET",
  "APO_CLOUDFLARE_TUNNEL_TOKEN",
  "DATABASE_URL",
  "APO_BACKEND_URL",
  "TUNNEL_TOKEN",
];
for (const key of SECRET_KEYS) {
  assert(
    !(key in docsEnv),
    `docs service must not receive secret ${key}`,
  );
}

// Healthcheck against the docs container's own /start.md.
const hc = Array.isArray(docs.healthcheck?.test) ? docs.healthcheck.test.join(" ") : "";
assert(
  hc.includes("8080") && hc.includes("start.md"),
  "docs healthcheck must probe http://localhost:8080/start.md",
);

// Caddy depends on docs health before accepting the docs route.
const caddy = rendered.services?.caddy;
assert(caddy, "tunnel overlay must include caddy");
const caddyDocsDep = caddy.depends_on?.docs;
assert(
  caddyDocsDep?.condition === "service_healthy",
  "caddy must depend on docs service_healthy",
);

// ---------------------------------------------------------------------------
// 8. Caddy routing is host-terminal.
// ---------------------------------------------------------------------------
const caddyfile = readFileSync("deploy/self-host/Caddyfile", "utf8");
const docsBlockIdx = caddyfile.indexOf("{$APO_DOCS_HOST}");
const appBlockIdx = caddyfile.indexOf("{$APO_CADDY_SITE_ADDRESS}");
assert(docsBlockIdx !== -1, "Caddyfile must define a {$APO_DOCS_HOST} site block");
assert(appBlockIdx !== -1, "Caddyfile must define the {$APO_CADDY_SITE_ADDRESS} app block");
assert(
  docsBlockIdx < appBlockIdx,
  "docs host block must precede the application block",
);

const docsBlock = caddyfile.slice(docsBlockIdx, appBlockIdx);
assert(
  docsBlock.includes("reverse_proxy docs:8080"),
  "docs host block must proxy only to docs:8080",
);
assert(
  !docsBlock.includes("auth.fragment"),
  "docs host block must not import the Basic Auth fragment",
);
assert(
  caddyfile.slice(appBlockIdx).includes("auth.fragment"),
  "application host block must still reach the Basic Auth fallback",
);
assertEnvironment(caddy, "APO_DOCS_HOST", DOCS_HOST);

// ---------------------------------------------------------------------------
// 9. Locally managed tunnel publishes both hostnames.
// ---------------------------------------------------------------------------
const tunnelConfig = readFileSync(
  "deploy/self-host/cloudflared-config.yml",
  "utf8",
);
const docsIngressIdx = tunnelConfig.indexOf(`hostname: ${DOCS_HOST}`);
const appIngressIdx = tunnelConfig.indexOf(`hostname: ${APP_HOST}`);
const catch404Idx = tunnelConfig.indexOf("http_status:404");
assert(docsIngressIdx !== -1, `tunnel ingress must include ${DOCS_HOST}`);
assert(appIngressIdx !== -1, `tunnel ingress must include ${APP_HOST}`);
assert(catch404Idx !== -1, "tunnel ingress must end with a terminal 404");
assert(
  docsIngressIdx < appIngressIdx && appIngressIdx < catch404Idx,
  "tunnel ingress must list docs host first, app host second, 404 last",
);
assert(
  tunnelConfig.includes("service: http://caddy:8080"),
  "both hostnames must target http://caddy:8080",
);

console.log("public docs contract: ok");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEnvironment(service, name, expected) {
  const actual = service.environment?.[name];
  assert(actual === expected, `${name} must equal ${expected} on caddy`);
}

function assertNoHostPorts(service, message) {
  const hostPorts = service.ports?.filter(
    (p) => p.published !== undefined && String(p.published) !== "",
  );
  assert(!hostPorts || hostPorts.length === 0, message);
}

function assertContainerPort(service, port, message) {
  const found = service.expose?.some(
    (e) => Number(String(e).split(":")[0]) === port,
  );
  assert(found, message);
}
