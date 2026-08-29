/**
 * `apo runs export <run-id>` — dump a run as a self-contained JSON bundle.
 *
 * The backup side of evidence retention: before evidence expires (or a
 * garbage run is deleted), this captures everything the run holds —
 * verdict, checks, corrections, judgment evidence, deliverables (inline
 * values and artifact bytes base64), attempt diagnostics, the pinned eval
 * source, and the trace's calls. Never prompts — safe for agents and CI.
 */

import { writeFileSync } from "node:fs";
import { parseArgs, requirePositional } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatBytes } from "../lib/format.ts";
import { apiGet } from "../lib/api.ts";
import { resolveRunId } from "../lib/runs-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";

type RunExportBundle = {
  bundle_version: number;
  exported_at: string;
  run_id: string;
  run: { status: string; task_id: string } & Record<string, unknown>;
  corrections: unknown[];
  judgments: unknown[];
  deliverables: {
    manifest: unknown[];
    values: Record<string, unknown>;
    artifacts: Record<string, unknown>;
  };
  attempt: Record<string, unknown> | null;
  task_definition_source: Record<string, unknown> | null;
  trace: { trace_ids: string[]; calls: unknown[]; spans?: unknown[] } | null;
};

// Artifact-heavy bundles can be hundreds of MiB; the default 15s timeout
// is too tight for them.
const EXPORT_TIMEOUT_MS = 120_000;

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);

  let input: string;
  try {
    input = requirePositional(positional, 0, "run-id");
  } catch {
    console.error("Missing required argument: <run-id>");
    console.error(dim("Usage: apo runs export <run-id> [--out <file>] [--spans]"));
    return 2;
  }

  let runId: string;
  try {
    runId = await resolveRunId(config.backendUrl, input, config);
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  const params: Record<string, string> = {};
  if (flags.spans === true) params.include = "spans";

  let bundle: RunExportBundle;
  try {
    bundle = await apiGet<RunExportBundle>(
      config.backendUrl,
      `/v1/agent-task-runs/${encodeURIComponent(runId)}/export`,
      Object.keys(params).length > 0 ? params : undefined,
      config,
      EXPORT_TIMEOUT_MS,
    );
  } catch (error) {
    return reportCommandError(error, config.backendUrl);
  }

  const outPath =
    (typeof flags.out === "string" && flags.out) ||
    `run-${runId.slice(0, 12)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const serialized = JSON.stringify(bundle, null, 2);
  try {
    writeFileSync(outPath, serialized + "\n");
  } catch (error) {
    console.error(`Could not write ${outPath}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  console.log(`${bold(outPath)}  ${dim(formatBytes(serialized.length))}`);
  console.log(dim(sectionsLine(bundle)));
  return 0;
}

function sectionsLine(bundle: RunExportBundle): string {
  const parts = [
    `${bundle.run.task_id} (${bundle.run.status})`,
    `${bundle.deliverables.manifest.length} deliverables`,
    `${bundle.judgments.length} judgments`,
    `${bundle.trace ? `${bundle.trace.calls.length} calls` : "no trace"}`,
  ];
  if (bundle.trace?.spans?.length) parts.push(`${bundle.trace.spans.length} spans`);
  if (bundle.task_definition_source) parts.push("eval source");
  return parts.join(" · ");
}
