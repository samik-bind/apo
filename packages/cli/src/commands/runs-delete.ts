/**
 * `apo runs delete <run-id>... --yes` — permanently delete bad runs.
 *
 * A run whose result is garbage (harness failure, dead DB connection, wrong
 * environment) can be deleted so it stops polluting lists and stats. Removes
 * the run's checks, judgments, corrections, deliverables (rows and stored
 * objects), attempt, and trace; the parent batch's rollups are recomputed and
 * an emptied batch is removed. Destructive and irreversible: `--yes` is
 * required. Never prompts — safe for agents and CI.
 */

import { parseArgs } from "../lib/args.ts";
import { resolveConfig } from "../lib/config.ts";
import { bold, dim, formatJson } from "../lib/format.ts";
import { apiDelete } from "../lib/api.ts";
import { resolveRunId } from "../lib/runs-resolve.ts";
import { reportCommandError } from "../lib/command-error.ts";

type DeletionCounts = {
  ok: true;
  deleted_runs: number;
  deleted_traces: number;
  deleted_calls: number;
  deleted_batches: number;
};

export async function run(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const config = resolveConfig(flags);
  const json = flags.json === true;
  const confirmed = flags.yes === true;

  if (positional.length === 0) {
    console.error("Missing required argument: <run-id>...");
    console.error(dim("Usage: apo runs delete <run-id>... --yes"));
    return 2;
  }

  const taskFilter = flags.task as string | undefined;

  // Resolve every input (full id, unique prefix, or 'last') up front so the
  // --yes gate can name exactly what would go, and a typo never deletes a
  // different run mid-sequence.
  const inputs = [...new Set(positional)];
  const resolved: string[] = [];
  for (const input of inputs) {
    try {
      resolved.push(await resolveRunId(config.backendUrl, input, config, taskFilter));
    } catch (error) {
      return reportCommandError(error, config.backendUrl);
    }
  }

  if (!confirmed) {
    for (const runId of resolved) {
      console.log(`${bold(runId)} ${dim("would be deleted")}`);
    }
    console.error(dim("Pass --yes to permanently delete — this cannot be undone."));
    return 2;
  }

  const results: Array<{ run_id: string } & DeletionCounts> = [];
  for (const runId of resolved) {
    try {
      const counts = await apiDelete<DeletionCounts>(
        config.backendUrl,
        `/v1/agent-task-runs/${encodeURIComponent(runId)}`,
        config,
      );
      results.push({ run_id: runId, ...counts });
    } catch (error) {
      if (results.length > 0) printResults(results, json);
      return reportCommandError(error, config.backendUrl);
    }
  }

  printResults(results, json);
  return 0;
}

function printResults(results: Array<{ run_id: string } & DeletionCounts>, json: boolean): void {
  if (json) {
    console.log(formatJson(results));
    return;
  }
  for (const r of results) {
    const extras: string[] = [];
    if (r.deleted_traces > 0) extras.push(`${r.deleted_traces} trace${r.deleted_traces === 1 ? "" : "s"}`);
    if (r.deleted_batches > 0) extras.push("empty batch removed");
    const suffix = extras.length > 0 ? dim(`  (${extras.join(", ")})`) : "";
    console.log(`${bold(r.run_id)} deleted${suffix}`);
  }
  console.log(dim(`Deleted ${results.length} run${results.length === 1 ? "" : "s"}`));
}
