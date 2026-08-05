/**
 * The heartbeat is the backend's only evidence that a run is still alive: miss
 * ~4 in a row and the lease reaper marks the attempt `lost`, terminally, even
 * though the Task is still running fine.
 *
 * `apo task run` executes the Task in-process (`runTaskDirImpl`), so anything
 * the Task does synchronously — unzipping a DOCX, stringifying a large
 * deliverable — blocks the event loop and starves a `setInterval` heartbeat.
 * `apo connect` doesn't have this problem because it runs the Task in a child
 * process, which is why real-world loss is concentrated entirely on the
 * `task run` path.
 *
 * The invariant pinned here is the one that matters and is independent of how
 * the heartbeat is implemented: while the main thread is blocked, beats must
 * still reach the backend. The counting server therefore runs in a child
 * process — an in-process server would be blocked by the very stall under test
 * and could not observe anything.
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

const SERVER_SRC = `
const http = require('node:http');
const server = http.createServer((req, res) => {
  process.stdout.write('BEAT ' + Date.now() + '\\n');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ cancel_requested: false }));
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT ' + server.address().port + '\\n');
});
`;

interface BeatServer {
  port: number;
  /** Arrival wall-clock times, stamped by the (unblocked) server process. */
  beatsAt: () => number[];
  close: () => void;
}

async function startBeatServer(): Promise<BeatServer> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ["-e", SERVER_SRC], {
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

/** Occupy the main thread for `ms` the way synchronous Task work does. */
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin */
  }
}

/** Give the child's stdout a chance to drain into our counters. */
async function drain(ms = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

let server: BeatServer | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

describe("CallerHeartbeat liveness under a blocked main thread", () => {
  it("keeps heartbeating while the Task blocks the event loop", async () => {
    server = await startBeatServer();
    const hb = new CallerHeartbeat(`http://127.0.0.1:${server.port}`, lease, () => {}, 50);
    hb.start("running");
    await drain(150);

    // A Task doing 600ms of uninterrupted synchronous work. At a 50ms interval
    // the backend should still have seen roughly a dozen beats *inside* that
    // window — beats that land afterwards are too late to hold the lease.
    const blockStart = Date.now();
    blockEventLoop(600);
    const blockEnd = Date.now();
    await drain();
    await hb.stop();

    const during = server.beatsAt().filter((t) => t >= blockStart && t <= blockEnd);
    expect(during.length).toBeGreaterThanOrEqual(5);
  }, 20_000);

  it("stops heartbeating once stopped", async () => {
    server = await startBeatServer();
    const hb = new CallerHeartbeat(`http://127.0.0.1:${server.port}`, lease, () => {}, 25);
    hb.start("running");
    await drain(200);
    await hb.stop();
    await drain();

    const afterStop = server.beatsAt().length;
    await drain();
    expect(server.beatsAt().length).toBe(afterStop);
  }, 20_000);
});
