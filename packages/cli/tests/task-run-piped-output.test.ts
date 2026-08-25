import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/*
 * Issue #155 regression: `apo task run` on a FAIL verdict prints the checks
 * summary followed by the SPEC-180 Run:/Inspect: identity lines, then exits
 * 1. Writes to a pipe are asynchronous — a bare `process.exit` can drop the
 * writes still queued in userspace, so every scripted/CI consumer (`| tail`,
 * `| grep`, logs) lost the run identity and had to recover it via
 * `apo runs list`.
 *
 * The scene reproduces the truncation conditions exactly: a deterministic
 * failing Task whose summary exceeds the 64 KiB OS pipe buffer, a spawned
 * real CLI with piped stdout, and a deliberately slow pipe consumer so the
 * child's final writes pend in its userspace queue at exit time. The
 * entrypoint's flush-before-exit (main.ts flushAndExit) must keep the
 * identity lines intact.
 */

const FIXTURE_ROOT = resolve(__dirname, "fixtures");
const MAIN = resolve(__dirname, "../src/main.ts");

/** ANSI SGR sequences stripped so assertions match styled CLI output.
 * Built via fromCharCode — linters flag control-character escapes in source. */
function stripAnsi(text: string): string {
  const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return text.replace(sgr, "");
}

function startFakeServer(): Promise<{
  server: Server;
  port: number;
}> {
  return new Promise((resolveReady) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = req.url ?? "";
        const json = (o: unknown, status = 200) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(o));
        };
        const port = (server.address() as AddressInfo).port;

        if (url === "/health") return json({ ok: true });
        if (url.endsWith("/v1/agent-task-batch-runs/caller")) {
          return json(
            {
              batch_run_id: "bch-flush",
              task_run_id: "run-flush",
              attempt_id: "att-flush",
              lease_generation: 1,
              lease_expires_at: "2027-01-01T00:00:00Z",
              attempt_jwt: "jwt-flush",
              trace_endpoint: `http://127.0.0.1:${port}`,
              trace_project: "flush-proj",
            },
            201,
          );
        }
        // /start, /heartbeat, /result, and OTLP trace ingestion all succeed.
        json({ ok: true });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolveReady({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

/**
 * Flowing-mode reader throttled below the child's write speed: pause after
 * every chunk, resume a few milliseconds later. The child fills the OS pipe
 * buffer and its remaining writes back up in Node's userspace queue — the
 * exact state a forced exit truncates.
 */
async function drainSlowly(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => {
    chunks.push(c);
    stream.pause();
    setTimeout(() => stream.resume(), 5);
  });
  await once(stream, "end");
  return Buffer.concat(chunks).toString("utf8");
}

describe("task run piped output (issue #155)", () => {
  it(
    "keeps the Run:/Inspect: identity lines on the FAIL exit path when stdout is piped",
    { timeout: 60_000 },
    async () => {
      const { server, port } = await startFakeServer();
      const home = mkdtempSync(join(tmpdir(), "apo-flush-scene-"));
      const child = spawn(
        process.execPath,
        [
          "--experimental-strip-types", MAIN,
          "task", "run", "flush-fixture",
          "--dir", FIXTURE_ROOT,
        ],
        {
          env: {
            ...process.env,
            HOME: home,
            APO_BACKEND_URL: `http://127.0.0.1:${port}`,
            APO_API_KEY: "scene-user-key",
            APO_PROJECT_ID: "flush-proj",
            OPENAI_API_KEY: "",
            OPENAI_BASE_URL: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stderr = "";
      child.stderr.on("data", (c: Buffer) => {
        stderr += c.toString();
      });
      const exitedOrFailed = Promise.race([
        new Promise<number>((resolveExit) => {
          child.on("exit", (c) => resolveExit(c ?? -1));
        }),
        new Promise<number>((_, reject) =>
          setTimeout(
            () => reject(new Error(`timed out waiting for exit\n${stderr}`)),
            50_000,
          ),
        ),
      ]);

      const [code, rawStdout] = await Promise.all([
        exitedOrFailed,
        drainSlowly(child.stdout),
      ]);
      server.close();

      // Sanity: the scene really exercised the overflow condition.
      expect(Buffer.byteLength(rawStdout, "utf8")).toBeGreaterThan(64 * 1024);

      // The FAIL verdict path.
      expect(code).toBe(1);

      const stdout = stripAnsi(rawStdout);
      // SPEC-180: the recorded identity must survive the pipe.
      expect(stdout).toContain("Run:     run-flush");
      expect(stdout).toContain("Inspect: apo runs show run-flush");
      // ...and the checks summary itself must be complete, not just its head.
      expect(stdout).toContain("volume-failing-check-2999");
    },
  );
});
