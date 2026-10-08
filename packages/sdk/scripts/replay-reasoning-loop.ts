// Replay recorded judge reasoning through the repetition guard, as the judge
// stream would feed it (in small deltas), and report where each file trips.
//   node --experimental-strip-types scripts/replay-reasoning-loop.ts <file|dir>...
// A dir is read for *.txt (one reasoning per file) and *.jsonl (one reasoning
// string per line, or an object with a `reasoning` field).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describeTrip, RepetitionGuard } from "../src/agent-task/checks/reasoning-loop.ts";

const DELTA_CHARS = 16;

function* samples(path: string): Generator<{ name: string; text: string }> {
  if (statSync(path).isDirectory()) {
    for (const entry of readdirSync(path).sort()) yield* samples(join(path, entry));
  } else if (path.endsWith(".jsonl")) {
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as string | { reasoning?: string };
      const text = typeof row === "string" ? row : row.reasoning;
      if (text) yield { name: `${path}:${i + 1}`, text };
    }
  } else if (path.endsWith(".txt")) {
    yield { name: path, text: readFileSync(path, "utf8") };
  }
}

let files = 0;
let chars = 0;
let trips = 0;
const started = Date.now();
for (const arg of process.argv.slice(2)) {
  for (const { name, text } of samples(arg)) {
    files++;
    chars += text.length;
    const guard = new RepetitionGuard({ diversity: true });
    for (let i = 0; i < text.length && !guard.tripped; i += DELTA_CHARS) {
      guard.push(text.slice(i, i + DELTA_CHARS));
    }
    const trip = guard.tripped;
    if (trip) {
      trips++;
      console.log(`TRIP  ${name}  (${text.length} chars): ${trip.rule} — ${describeTrip(trip)}`);
    } else if (process.env.VERBOSE) {
      console.log(`ok    ${name}  (${text.length} chars)`);
    }
  }
}
console.log(
  `${files} reasoning(s), ${chars.toLocaleString()} chars, ${trips} trip(s), ${Date.now() - started} ms`,
);
