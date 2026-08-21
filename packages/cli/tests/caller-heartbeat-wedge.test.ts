/**
 * Two ways a healthy run still loses its lease, both observed in the field on
 * 2026-08-17/18 against a hosted backend (bind's e2e suite, runs
 * `run_dc0450d6066c964da8226b0c` and `run_0b97be34e9fddf1849a11d13`).
 *
 * 1. A beat that never returns wedges every later beat. The worker guards with
 *    `inFlight` and issues `fetch` with no timeout, so one request that hangs
 *    suppresses the interval forever. The lease (90s) then lapses behind a
 *    20s interval that looks healthy from the outside — nothing is logged,
 *    because nothing failed; beats simply stopped being sent.
 *
 * 2. Once the reaper has declared the attempt `lost`, every subsequent beat
 *    returns `409 state_mismatch`. That is terminal — no result can be
 *    submitted against a lost lease — but it is reported as an ordinary failed
 *    beat, so the run continues. One observed run kept working for 25 further
 *    minutes and 73 model calls before discovering it at submission.
 *
 * Both are pinned here as behaviour of the beat stream, independent of how the
 * heartbeat is implemented: the counting server runs in a child process so it
 * observes arrivals rather than intentions.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { CallerHeartbeat, type CallerLease } from "../src/lib/caller-execution.ts";

const lease: CallerLease = {
  attemptId: "att-1",
  generation: 1,
  token: "jwt-1",
  expiresAt: "2026-01-01T00:00:00Z",
};

/** Swallows the first beat (never responds), answers every later one. */
const HANG_FIRST_SRC = `
const http = require('node:http');
let seen = 0;
const server = http.createServer((req, res) => {
  seen += 1;
  process.stdout.write('BEAT ' + Date.now() + '\\n');
  if (seen === 1) return;               // hold the socket open, never answer
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ cancel_requested: false }));
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT ' + server.address().port + '\\n');
});
`;

/** The state the reaper leaves behind once it has declared the attempt lost. */
const LOST_LEASE_SRC = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  process.stdout.write('BEAT ' + Date.now() + '\\n');
  res.writeHead(409, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ detail: { kind: 'state_mismatch', msg: "cannot heartbeat from status 'lost'" } }));
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
});

describe("CallerHeartbeat when a beat never returns", () => {
  it("keeps beating after a request that hangs", async () => {
    server = await startBeatServer(HANG_FIRST_SRC);
    const hb = new CallerHeartbeat(`http://127.0.0.1:${server.port}`, lease, () => {}, 50);
    hb.start("running");

    // Long enough that a bounded beat has been abandoned and several
    // replacements have gone out. A wedged stream stays at exactly one.
    await drain(2_600);
    await hb.stop();

    expect(server.beatsAt().length).toBeGreaterThanOrEqual(2);
  }, 20_000);
});

describe("CallerHeartbeat when the lease is already lost", () => {
  it("reports a 409 state_mismatch as stale rather than a retryable failure", async () => {
    server = await startBeatServer(LOST_LEASE_SRC);
    let staleCalls = 0;
    const hb = new CallerHeartbeat(
      `http://127.0.0.1:${server.port}`,
      lease,
      () => {
        staleCalls += 1;
      },
      50,
    );
    hb.start("running");
    await drain(600);
    await hb.stop();

    expect(staleCalls).toBeGreaterThanOrEqual(1);
  }, 20_000);
});
