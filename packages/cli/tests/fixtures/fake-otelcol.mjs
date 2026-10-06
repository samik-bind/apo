#!/usr/bin/env node
// Stand-in for otelcol-contrib in collector lifecycle tests: answers the health
// check, accepts OTLP posts, and reports an empty exporter queue. Ports come from
// the same env vars the CLI renders the real config from (the child inherits them).
import { createServer } from "node:http";

// Real otelcol loads its config before binding; a delay reproduces the window
// in which a second spawner's health check is answered by the first one.
await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_OTELCOL_START_DELAY_MS ?? 0)));

const listen = (port, handler) => createServer(handler).listen(Number(port), "127.0.0.1");
const servers = [
  listen(process.env.APO_COLLECTOR_HEALTH_PORT, (_req, res) => res.end("ok")),
  listen(process.env.APO_COLLECTOR_PORT, (_req, res) => res.end()),
  listen(process.env.APO_COLLECTOR_METRICS_PORT, (_req, res) =>
    res.end("otelcol_exporter_queue_size 0\notelcol_exporter_in_flight_requests 0\notelcol_exporter_send_failed_spans 0\n"),
  ),
];
for (const server of servers) server.on("error", () => process.exit(1)); // port taken: exit like otelcol
process.on("SIGTERM", () => process.exit(0));
