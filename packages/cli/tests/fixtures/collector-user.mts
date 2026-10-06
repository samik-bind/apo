// A second process using the collector, for lifecycle tests: starts a handle
// (spawning or reusing), prints "ready <reused>", and on SIGTERM releases it and
// prints the stop() outcome. SIGKILL simulates a command dying without stopping.
import { startCollector } from "../../src/lib/collector.ts";

const handle = await startCollector({ backendUrl: process.env.TEST_BACKEND_URL!, authHeader: "Bearer test-key" });
console.log(`ready ${handle.reused}`);
process.on("SIGTERM", () => {
  void handle.stop().then((outcome) => {
    console.log(`stopped ${outcome}`);
    process.exit(0);
  });
});
setInterval(() => undefined, 1_000);
