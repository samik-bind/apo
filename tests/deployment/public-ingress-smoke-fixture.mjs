// Fixture server for the public-ingress smoke contract (SPEC-182 tests 5-6).
//
// Two modes, selected by argv[2]:
//   basic-gate — the former broken ingress: every route except public health
//                answers 401 with `WWW-Authenticate: Basic realm="restricted"`.
//                The smoke script must FAIL against this.
//   app        — the SPEC-182 target: admission shells and public auth routes
//                answer as Apo would; protected data answers Apo JSON 401
//                without any Basic challenge. The smoke script must PASS.
//
// Usage: node tests/deployment/public-ingress-smoke-fixture.mjs <port> <mode>
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const mode = process.argv[3];
if (!Number.isInteger(port) || port <= 0 || !["basic-gate", "app"].includes(mode)) {
  throw new Error("usage: node public-ingress-smoke-fixture.mjs <port> <basic-gate|app>");
}

const BASIC_CHALLENGE = { "WWW-Authenticate": 'Basic realm="restricted"' };
const JSON_HEADERS = { "Content-Type": "application/json" };

/** Routes that emulate the backend's bounded public/unauth responses in app mode. */
function appResponse(req, res) {
  const path = new URL(req.url, "http://fixture.invalid").pathname;

  if (path === "/api/public/health") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ status: "ready" }));
    return;
  }

  // Admission shells — the dashboard serves these unauthenticated.
  if (path === "/login" || path === "/join") {
    res.writeHead(200, { "Content-Type": "text/html", "Strict-Transport-Security": "max-age=31536000" });
    res.end("<!doctype html><title>apo fixture</title>");
    return;
  }

  // Public auth route — bounded installation status.
  if (path === "/auth/has-users") {
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ has_users: true, setup_available: false }));
    return;
  }

  // CLI bootstrap — Apo's own credential validation (invalid → 401 JSON).
  if (path === "/v1/api-keys/bootstrap") {
    res.writeHead(401, JSON_HEADERS);
    res.end(JSON.stringify({ detail: "Invalid credentials" }));
    return;
  }

  // Protected data — Apo 401 JSON, never a Basic challenge.
  if (path === "/v1/projects" || path === "/api/public/otel/v1/traces") {
    res.writeHead(401, JSON_HEADERS);
    res.end(JSON.stringify({ detail: "Not authenticated" }));
    return;
  }

  // Raw operator diagnostics and removed legacy routes — terminal denial.
  // Any unhandled /v1/* path is a removed backend route.
  if (
    path.startsWith("/backend-proxy/") ||
    path === "/api/health/ready" ||
    path.startsWith("/public/traces/") ||
    (path.startsWith("/v1/") && path !== "/v1/api-keys/bootstrap" && path !== "/v1/projects")
  ) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  // Dashboard fallback.
  res.writeHead(200, { "Content-Type": "text/html", "Strict-Transport-Security": "max-age=31536000" });
  res.end("<!doctype html><title>apo fixture</title>");
}

const server = createServer((req, res) => {
  if (mode === "basic-gate" && req.url !== "/api/public/health") {
    // The pre-SPEC-182 Caddy layer: one installation-wide password in front
    // of every browser and CLI admission path.
    res.writeHead(401, { "Content-Type": "text/plain", ...BASIC_CHALLENGE });
    res.end("401 Unauthorized");
    return;
  }
  appResponse(req, res);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fixture:${mode}:${port}\n`);
});
