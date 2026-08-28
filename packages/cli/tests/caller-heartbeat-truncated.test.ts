/**
 * Issue #176: a heartbeat whose response body never arrives (or is not
 * JSON) was counted as a *successful* beat. `fetch` resolves as soon as the
 * response headers arrive; if the body then stalls, the worker's
 * `resp.json().catch(() => null)` swallowed the abort and posted
 * `type: 'response'` — the parent reset its failure count, logged nothing,
 * and a `cancel_requested` signal in that response was silently lost. The
 * lease could lapse while the client believed every beat succeeded.
 *
 * Both server shapes here are observed in the field: an ingress that
 * flushes `200` headers and cuts the body (truncated), and a complete
 * response whose body is not parseable JSON. A beat on either stream must
 * be reported as a failed beat — visible as the "heartbeat failed (N in a
 * row)" warning — not as silence. And once no beat has succeeded for a
 * while, the watchdog must say so in terms of the lease, because per-beat
 * errors alone cannot distinguish "failing" from "dead".
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CallerHeartbeat, type CallerLease } from "../src/lib/caller-execution.ts";

const lease: CallerLease = {
  attemptId: "att-1",
  generation: 1,
  token: "jwt-1",
  expiresAt: "2026-01-01T00:00:00Z",
};

/** Sends 200 headers, a partial JSON body, then holds the socket open. */
const TRUNCATED_BODY_SRC = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  process.stdout.write('BEAT ' + Date.now() + '\\n');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('{"cancel_request');        // body starts, never finishes
  // no res.end() — the socket stays open until the client gives up
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT ' + server.address().port + '\\n');
});
`;

/** A complete response whose body is not parseable JSON. */
const INVALID_JSON_SRC = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  process.stdout.write('BEAT ' + Date.now() + '\\n');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"cancel_requested": tr');
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT ' + server.address().port + '\\n');
});
`;

interface BeatServer {
  port: number;
  beatsAt: () => number[];
  close: () => void;
}

async function startBeatServer(src: string): Promise<BeatServer> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["-e", src], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  const beats: number[] = [];
  let port = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("PORT ")) port = Number(line.slice(5));
      else if (line.startsWith("BEAT ")) beats.push(Number(line.slice(5)));
    }
  });

  const deadline = Date.now() + 10_000;
  while (port === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (port === 0) throw new Error("beat server did not report a port");

  return { port, beatsAt: () => [...beats], close: () => child.kill() };
}

async function drain(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

let server: BeatServer | null = null;
afterEach(() => {
  server?.close();
  server = null;
  vi.restoreAllMocks();
});

describe("CallerHeartbeat when a 200 response body is truncated", () => {
  it("counts the beat as failed, not as a silent success", async () => {
    server = await startBeatServer(TRUNCATED_BODY_SRC);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const hb = new CallerHeartbeat(`http://127.0.0.1:${server.port}`, lease, () => {}, 50);
    hb.start("running");
    // timeoutMs is floored at 1s, so the first abandoned body-read lands ~1s in.
    await drain(2_600);
    await hb.stop();

    // The server saw beats, and the client said something about them failing.
    expect(server.beatsAt().length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => /heartbeat failed \(\d+ in a row\)/.test(e))).toBe(true);
  }, 20_000);
});

describe("CallerHeartbeat when a 200 response body is not JSON", () => {
  it("counts the beat as failed, not as a silent success", async () => {
    server = await startBeatServer(INVALID_JSON_SRC);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const hb = new CallerHeartbeat(`http://127.0.0.1:${server.port}`, lease, () => {}, 50);
    hb.start("running");
    await drain(700);
    await hb.stop();

    expect(server.beatsAt().length).toBeGreaterThanOrEqual(1);
    expect(errors.some((e) => /heartbeat failed \(\d+ in a row\)/.test(e))).toBe(true);
  }, 20_000);
});

describe("CallerHeartbeat watchdog when no beat succeeds", () => {
  it("warns in terms of the lease once beats have failed for a while", async () => {
    server = await startBeatServer(INVALID_JSON_SRC);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const hb = new CallerHeartbeat(`http://127.0.0.1:${server.port}`, lease, () => {}, 50);
    hb.start("running");
    // Watchdog threshold is 2 intervals = 100ms; plenty of failed beats land.
    await drain(700);
    await hb.stop();

    expect(
      errors.some((e) => /no successful heartbeat for \d+(\.\d+)?s/.test(e)),
    ).toBe(true);
  }, 20_000);
});
