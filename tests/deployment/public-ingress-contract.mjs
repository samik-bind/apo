import { readFileSync } from "node:fs";

const publicUrl = "https://apo.example.com";
const disabledDocsRenderedPath = process.argv[2];
const configuredDocsRenderedPath = process.argv[3];
if (!disabledDocsRenderedPath || !configuredDocsRenderedPath) {
  throw new Error(
    "usage: node tests/deployment/public-ingress-contract.mjs <docs-disabled-compose.json> <docs-configured-compose.json>",
  );
}
const rendered = JSON.parse(readFileSync(disabledDocsRenderedPath, "utf8"));
const configuredDocsRendered = JSON.parse(
  readFileSync(configuredDocsRenderedPath, "utf8"),
);

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
assertBindMount(
  rendered.services.caddy,
  "/etc/caddy/auth.fragment",
  "deploy/self-host/auth.fragment",
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

function assertBindMount(service, target, sourceSuffix) {
  const found = service.volumes?.some(
    (entry) =>
      entry.type === "bind" &&
      entry.target === target &&
      entry.source.endsWith(sourceSuffix) &&
      entry.read_only === true,
  );
  assert(found, `Caddy must mount ${sourceSuffix} read-only at ${target}`);
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
