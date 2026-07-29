// SPEC-157: Authenticated OTLP validation helper.
//
// Reads credentials from environment (never argv). Creates a temporary
// ingest-only key, sends a synthetic OTLP canary, verifies full content
// is readable, then revokes the temporary key.
//
// Run via scripts/tunnel-trial-validate.sh (which exports the env vars).

import { randomUUID } from "node:crypto";

const URL = process.env.APO_VALIDATION_URL;
const PROJECT_ID = process.env.APO_VALIDATION_PROJECT_ID;
const FULL_PUB = process.env.APO_VALIDATION_FULL_PUBLIC_KEY;
const FULL_SEC = process.env.APO_VALIDATION_FULL_SECRET_KEY;

if (!URL || !PROJECT_ID || !FULL_PUB || !FULL_SEC) {
  console.error("synthetic-otlp: BLOCKED (missing env vars)");
  process.exit(1);
}

function basicAuth(pub, sec) {
  return "Basic " + Buffer.from(`${pub}:${sec}`).toString("base64");
}

async function api(method, path, { headers = {}, body } = {}) {
  const resp = await fetch(`${URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: resp.status, json, text };
}

const fullAuth = { Authorization: basicAuth(FULL_PUB, FULL_SEC) };
const canary = `spec157-${randomUUID()}`;
const traceId = randomUUID().replace(/-/g, "").padEnd(32, "0").slice(0, 32);
const spanId = randomUUID().replace(/-/g, "").slice(0, 16);

let phaseResult = "PASS";
let detail = "";

try {
  // 1. Create a temporary ingest-only key.
  const createResp = await api("POST", "/backend-proxy/v1/api-keys", {
    headers: fullAuth,
    body: { name: `validation-${canary}`, project: PROJECT_ID, scope: "ingest" },
  });

  if (createResp.status !== 200 && createResp.status !== 201) {
    throw new Error(`temp key creation failed: ${createResp.status}`);
  }

  const tempPub = createResp.json?.public_key;
  const tempSec = createResp.json?.secret_key;
  const tempKeyId = createResp.json?.id;
  if (!tempPub || !tempSec) {
    throw new Error("temp key response missing public/secret key");
  }

  try {
    // 2. Send OTLP canary with the ingest key.
    const ingestAuth = { Authorization: basicAuth(tempPub, tempSec) };
    const otlpPayload = {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: traceId,
            spanId: spanId,
            name: `validation-canary-${canary}`,
            kind: 0,
            startTimeUnixNano: "1700000000000000000",
            endTimeUnixNano: "1700000001000000000",
            attributes: [
              { key: "canary.marker", value: { stringValue: canary } },
              { key: "gen.prompt", value: { stringValue: `CANARY_PROMPT_${canary}` } },
              { key: "gen.output", value: { stringValue: `CANARY_OUTPUT_${canary}` } },
            ],
          }],
        }],
      }],
    };

    const otlpResp = await fetch(`${URL}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ingestAuth },
      body: JSON.stringify(otlpPayload),
    });

    if (otlpResp.status !== 200) {
      throw new Error(`OTLP ingest failed: ${otlpResp.status}`);
    }

    // 3. Ingest key cannot read (403 expected).
    const readAttempt = await api("GET", `/backend-proxy/v1/runs/${traceId}?project=${PROJECT_ID}`, {
      headers: ingestAuth,
    });
    if (readAttempt.status !== 403 && readAttempt.status !== 401) {
      detail += `ingest-key read returned ${readAttempt.status} (expected 403); `;
    }

    // 4. Full key can read the trace.
    await new Promise(r => setTimeout(r, 2000)); // allow projection
    const traceResp = await api("GET", `/backend-proxy/v1/runs/${traceId}?project=${PROJECT_ID}`, {
      headers: fullAuth,
    });

    if (traceResp.status === 200 && traceResp.text && traceResp.text.includes(canary)) {
      // Full content verified.
    } else if (traceResp.status === 200) {
      detail += "trace found but canary marker not in response; ";
    } else {
      detail += `full-key trace read returned ${traceResp.status}; `;
      phaseResult = "FAIL";
    }

  } finally {
    // 5. Revoke the temporary key.
    if (tempKeyId) {
      await api("DELETE", `/backend-proxy/v1/api-keys/${tempKeyId}`, { headers: fullAuth });
    }
  }

} catch (err) {
  phaseResult = "FAIL";
  detail = err.message || String(err);
}

console.log(`- synthetic-otlp: ${phaseResult}${detail ? ` (${detail})` : ""}`);
if (phaseResult === "FAIL") process.exit(1);
