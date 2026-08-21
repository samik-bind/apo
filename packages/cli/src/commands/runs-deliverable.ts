/**
 * `apo runs deliverable <run-id> [name]` — read a run's deliverables without
 * re-rendering the whole run.
 *
 * Uses the manifest endpoint (metadata only) by default, and fetches exactly
 * one body when a name is given — never the whole run. Binary Artifacts stream
 * to stdout or `--output <path>`; an interactive terminal without `--output`
 * is refused so binary bytes are not dumped to a TTY.
 */
import { createWriteStream } from "node:fs";
import { isatty } from "node:tty";
import { parseArgs, getFlagValue } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";
import { apiGet, apiStream } from "../lib/api.ts";
import type { DeliverableSummary } from "../lib/agent-task-types.ts";
import { resolveRunId } from "../lib/runs-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";

type Manifest = {
  task_run_id: string;
  items: DeliverableSummary[];
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const taskFilter = getFlagValue(flags, "task");
  const outputPath = getFlagValue(flags, "output");

  const input = positional[0];
  if (!input) {
    console.error("Missing required argument: <run-id>");
    console.error(dim("Usage: apo runs deliverable <run-id> [name] [--output <path>]"));
    return 2;
  }
  const name = positional[1];

  let runId: string;
  try {
    runId = await resolveRunId(config.backendUrl, input, config, taskFilter);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "NO_RUNS") {
      const scope = taskFilter ? ` for task "${taskFilter}"` : "";
      console.error(`No runs found${scope}.`);
      return 2;
    }
    return reportCommandError(error, config.backendUrl);
  }

  let manifest: Manifest;
  try {
    manifest = await apiGet<Manifest>(
      config.backendUrl,
      `/v1/agent-task-runs/${runId}/deliverables`,
      undefined,
      config,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      console.error(`Run not found: ${runId}`);
    } else {
      console.error(message);
    }
    return 2;
  }

  if (manifest.items.length === 0) {
    console.error(`Run ${runId} has no deliverables.`);
    return 0;
  }

  if (!name) {
    if (config.json) {
      console.log(formatJson(manifest.items));
    } else {
      printManifest(runId, manifest.items);
    }
    return 0;
  }

  const item = manifest.items.find((it) => it.name === name);
  if (!item) {
    const available = manifest.items.map((it) => it.name).join(", ");
    console.error(
      `Deliverable "${name}" not found on run ${runId}. Available: ${available}`,
    );
    return 2;
  }

  return fetchOne(runId, item, config, outputPath);
}

async function fetchOne(
  runId: string,
  item: DeliverableSummary,
  config: ReturnType<typeof resolveConfig>,
  outputPath: string | undefined,
): Promise<number> {
  const path = `/v1/agent-task-runs/${runId}/deliverables/${item.id}`;

  if (item.kind === "artifact") {
    return downloadArtifact(item, path, config, outputPath, runId);
  }

  // JSON deliverable: stream the body, parse, print.
  try {
    const response = await apiStream(config.backendUrl, path, config);
    const text = await response.text();
    if (config.json) {
      console.log(text);
    } else {
      console.log(formatJson(JSON.parse(text)));
    }
    return 0;
  } catch (error) {
    reportFetchError(error, runId, item.id);
    return 2;
  }
}

async function downloadArtifact(
  item: DeliverableSummary,
  path: string,
  config: ReturnType<typeof resolveConfig>,
  outputPath: string | undefined,
  runId: string,
): Promise<number> {
  // Resolve output path: --output <dir>/ or "." auto-derives from display_filename.
  let resolvedOutput = outputPath;
  if (outputPath && (outputPath === "." || outputPath.endsWith("/"))) {
    const filename = item.display_filename || item.name;
    resolvedOutput = outputPath === "." ? filename : `${outputPath}${filename}`;
  }

  if (!resolvedOutput && (process.stdout.isTTY === true || isatty(1))) {
    // Refuse to dump binary bytes to an interactive terminal.
    console.error(
      `Deliverable "${item.name}" is a binary artifact (${item.media_type}, ${item.size_bytes} bytes).`,
    );
    console.error(dim(`Use --output <path> (or --output . to use the original filename) to write it to a file.`));
    return 2;
  }

  try {
    const response = await apiStream(config.backendUrl, path, config);
    const reader = response.body?.getReader();
    if (!reader) {
      console.error("Empty download response.");
      return 2;
    }
    if (resolvedOutput) {
      // Stream to a file and await completion so the caller (and tests) see a
      // complete file before the process returns.
      await new Promise<void>((resolve, reject) => {
        const dest = createWriteStream(resolvedOutput);
        dest.on("error", reject);
        dest.on("finish", () => resolve());
        (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) dest.write(Buffer.from(value));
          }
          dest.end();
        })().catch(reject);
      });
      return 0;
    }
    // stdout: write synchronously through the piped stream.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) process.stdout.write(Buffer.from(value));
    }
    return 0;
  } catch (error) {
    reportFetchError(error, runId, item.id);
    return 2;
  }
}

function printManifest(runId: string, items: DeliverableSummary[]): void {
  console.log(bold(`Deliverables for run ${runId}:`));
  const nameWidth = Math.max(...items.map((it) => it.name.length), 4);
  for (const item of items) {
    const size = `${item.size_bytes.toLocaleString()} bytes`;
    const filename = item.display_filename ? dim(` (${item.display_filename})`) : "";
    console.log(
      `  ${item.name.padEnd(nameWidth)}  ${item.kind.padEnd(8)}  ${size}${filename}`,
    );
  }
  console.log(dim(`\nRead one: apo runs deliverable <run-id> <name>`));
}

function reportFetchError(error: unknown, runId: string, deliverableId: string): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("404")) {
    console.error(
      `Deliverable ${deliverableId} not found on run ${runId}.`,
    );
  } else {
    console.error(message);
  }
}
