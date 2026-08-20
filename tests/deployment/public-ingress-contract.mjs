// SPEC-182 contract: the public origin delegates identity to Apo application
// auth. The ingress (Caddy) must not mount or import an installation-wide
// Basic Auth gate on any supported profile.
import { readFileSync } from "node:fs";

const publicUrl = "https://apo.example.com";
const disabledDocsRenderedPath = process.argv[2];
const configuredDocsRenderedPath = process.argv[3];
const tunnelRenderedPath = process.argv[4];
if (
  !disabledDocsRenderedPath ||
  !configuredDocsRenderedPath ||
  !tunnelRenderedPath
) {
  throw new Error(
    "usage: node tests/deployment/public-ingress-contract.mjs <docs-disabled-compose.json> <docs-configured-compose.json> <tunnel-compose.json>",
  );
}
const rendered = JSON.parse(readFileSync(disabledDocsRenderedPath, "utf8"));
const configuredDocsRendered = JSON.parse(
  readFileSync(configuredDocsRenderedPath, "utf8"),
);
const tunnelRendered = JSON.parse(readFileSync(tunnelRenderedPath, "utf8"));

assert(rendered.services.caddy, "Server Profile must include Caddy");
assertEnvironment(rendered.services.caddy, "APO_PUBLIC_URL", publicUrl);
assertEnvironment(
  rendered.services.caddy,
  "APO_DOCS_HOST",
  "apo-docs-disabled.invalid",
);
assertEnvironment(
  configuredDocsRendered.services.caddy,
  "APO_DOCS_HOST",
  "docs.apo.example.com",
);
assertEnvironment(rendered.services.frontend, "NEXTAUTH_URL", publicUrl);
assertEnvironment(rendered.services.frontend, "BACKEND_URL", "http://backend:8000");
assertEnvironment(rendered.services.backend, "APO_DEPLOYMENT_PROFILE", "server");
assertEnvironment(rendered.services.backend, "APO_PUBLIC_URL", publicUrl);
assertEnvironment(rendered.services.backend, "FRONTEND_URL", publicUrl);

assertPublishedPort(rendered.services.caddy, 80, "tcp");
assertPublishedPort(rendered.services.caddy, 443, "tcp");
assertPublishedPort(rendered.services.caddy, 443, "udp");
assertLoopbackOnly(rendered.services.frontend, 3000);
assertLoopbackOnly(rendered.services.backend, 8000);

// SPEC-182: no supported profile mounts the ingress Basic Auth fragment —
// every supported rendered profile must be free of it.
assertNoAuthFragmentMount(rendered.services.caddy, "direct profile");
assertNoAuthFragmentMount(
  configuredDocsRendered.services.caddy,
  "docs-configured profile",
);
assertNoAuthFragmentMount(tunnelRendered.services.caddy, "tunnel profile");
assertNoAuthFragmentMount(
  tunnelRendered.services.caddy,
  "tunnel override profile",
);

const caddyfile = readFileSync("deploy/self-host/Caddyfile", "utf8");
assert(caddyfile.includes("{$APO_CADDY_SITE_ADDRESS}"), "Caddy must use APO_CADDY_SITE_ADDRESS");
assert(caddyfile.includes("reverse_proxy frontend:3000"), "Caddy must proxy only to the frontend");
assertRouteBefore(
  caddyfile,
  "handle @raw_diagnostics",
  "handle /backend-proxy/*",
  "Caddy must deny diagnostic aliases before the broad backend proxy",
);

// SPEC-182: the application host block owns no identity — no basic_auth
// directive, no imported fragment. Apo's auth middleware is the boundary.
const appBlockIdx = caddyfile.indexOf("{$APO_CADDY_SITE_ADDRESS}");
assert(appBlockIdx !== -1, "Caddyfile must define the app site block");
const appBlock = caddyfile.slice(appBlockIdx);
assert(
  !appBlock.includes("basic_auth"),
  "application host block must not contain a basic_auth directive",
);
assert(
  !appBlock.includes("auth.fragment"),
  "application host block must not import the Basic Auth fragment",
);
assert(
  !caddyfile.includes("import /etc/caddy/auth.fragment"),
  "Caddyfile must not import the Basic Auth fragment anywhere",
);

// The application block still routes everything it must: canonical OTLP,
// detail-free readiness, the API proxy, and the frontend fallback.
assert(
  appBlock.includes("handle /api/public/otel/v1/traces"),
  "application block must keep the canonical OTLP route",
);
assert(
  appBlock.includes("handle /api/public/health"),
  "application block must keep the public readiness route",
);
assert(
  appBlock.includes("handle /backend-proxy/*"),
  "application block must keep the API proxy route",
);
const fallbackIdx = appBlock.lastIndexOf("handle {");
assert(
  fallbackIdx !== -1 && appBlock.slice(fallbackIdx).includes("reverse_proxy frontend:3000"),
  "application block must fall back to the frontend",
);

console.log("public ingress contract: ok");

function assertEnvironment(service, name, expected) {
  assert(service.environment?.[name] === expected, `${name} must equal ${expected}`);
}

function assertPublishedPort(service, port, protocol) {
  const found = service.ports?.some(
    (entry) => Number(entry.published) === port && entry.protocol === protocol,
  );
  assert(found, `Caddy must publish ${port}/${protocol}`);
}

function assertLoopbackOnly(service, port) {
  const entries = service.ports?.filter((entry) => Number(entry.published) === port) ?? [];
  assert(entries.length === 1, `${service.name ?? "service"} must publish ${port} exactly once`);
  assert(entries[0].host_ip === "127.0.0.1", `${port} must bind only to 127.0.0.1`);
}

function assertNoAuthFragmentMount(service, profileName) {
  assert(service, `${profileName}: caddy service must exist`);
  const found = service.volumes?.some(
    (entry) => entry.type === "bind" && entry.target === "/etc/caddy/auth.fragment",
  );
  assert(
    !found,
    `${profileName}: caddy must not mount /etc/caddy/auth.fragment — the ingress does not own identity (SPEC-182)`,
  );
}

function assertRouteBefore(config, earlier, later, message) {
  const earlierIndex = config.indexOf(earlier);
  const laterIndex = config.indexOf(later);
  assert(earlierIndex >= 0, `missing route: ${earlier}`);
  assert(laterIndex >= 0, `missing route: ${later}`);
  assert(earlierIndex < laterIndex, message);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
