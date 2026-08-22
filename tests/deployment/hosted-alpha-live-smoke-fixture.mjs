// Fixture server for the hosted-alpha live-smoke contract (SPEC-183 tests 1-3).
//
// Four modes, selected by argv[2]:
//   ok                — the healthy hosted alpha: readiness, admission
//                       shells, Apo-shaped protected 401, live docs, and a
//                       reachable maintained example. The smoke must PASS.
//   basic-gate        — /login answers 401 with a Basic challenge (an outer
//                       ingress gate). The smoke must FAIL naming the
//                       application entrypoint.
//   stale-docs        — /hosted-alpha/ answers 404 (the docs image predates
//                       the page). The smoke must FAIL naming the hosted-alpha
//                       documentation.
//   internal-redirect — /login redirects to an internal container hostname.
//                       The smoke must FAIL naming the internal redirect.
//   unready           — readiness answers 503 (application not healthy).
//                       The smoke must FAIL naming readiness.
//
// The fixture serves both origins (app and docs) on one port; the contract
// passes the same loopback URL for both and points
// HOSTED_ALPHA_EXAMPLE_URL at the fixture so no internet is needed.
//
// Usage: node tests/deployment/hosted-alpha-live-smoke-fixture.mjs <port> <mode>
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const mode = process.argv[3];
if (
  !Number.isInteger(port) ||
  port <= 0 ||
  !["ok", "basic-gate", "stale-docs", "internal-redirect", "unready"].includes(mode)
) {
  throw new Error(
    "usage: node hosted-alpha-live-smoke-fixture.mjs <port> <ok|basic-gate|stale-docs|internal-redirect|unready>",
  );
}

const BASIC_CHALLENGE = { "WWW-Authenticate": 'Basic realm="restricted"' };
const JSON_HEADERS = { "Content-Type": "application/json" };
const HTML_HEADERS = {
  "Content-Type": "text/html",
  "Strict-Transport-Security": "max-age=31536000",
};

function healthyResponse(req, res) {
  const path = new URL(req.url, "http://fixture.invalid").pathname;

  if (path === "/api/public/health") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ status: "ready" }));
    return;
  }

  // Admission shells — the dashboard serves these unauthenticated.
  if (path === "/login" || path === "/join") {
    res.writeHead(200, HTML_HEADERS);
    res.end("<!doctype html><title>apo fixture</title>");
    return;
  }

  // Public auth route — bounded installation status.
  if (path === "/auth/has-users") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ has_users: true, setup_available: false }));
    return;
  }

  // Protected data — Apo 401 JSON, never a Basic challenge.
  if (path === "/v1/projects") {
    res.writeHead(401, JSON_HEADERS);
    res.end(JSON.stringify({ detail: "Not authenticated" }));
    return;
  }

  // Hosted docs pages.
  if (path === "/start.md" || path === "/hosted-alpha/") {
    res.writeHead(200, { "Content-Type": "text/markdown" });
    res.end("# hosted alpha fixture\n");
    return;
  }

  // Maintained example link (via HOSTED_ALPHA_EXAMPLE_URL override).
  if (path === "/maintained-example") {
    res.writeHead(200, HTML_HEADERS);
    res.end("<!doctype html><title>example fixture</title>");
    return;
  }

  res.writeHead(200, HTML_HEADERS);
  res.end("<!doctype html><title>apo fixture</title>");
}

const server = createServer((req, res) => {
  const path = new URL(req.url, "http://fixture.invalid").pathname;

  if (mode === "basic-gate" && path === "/login") {
    res.writeHead(401, { "Content-Type": "text/plain", ...BASIC_CHALLENGE });
    res.end("401 Unauthorized");
    return;
  }

  if (mode === "stale-docs" && path === "/hosted-alpha/") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }

  if (mode === "internal-redirect" && path === "/login") {
    res.writeHead(302, { Location: "http://backend:8000/login" });
    res.end();
    return;
  }

  if (mode === "unready" && path === "/api/public/health") {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "starting" }));
    return;
  }

  healthyResponse(req, res);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fixture:${mode}:${port}\n`);
});
