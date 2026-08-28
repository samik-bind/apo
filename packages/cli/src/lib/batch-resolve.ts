import type { Config } from "./config.ts";
import { apiGet } from "./api.ts";
import { findByPrefix } from "./prefix.ts";

/** Resolve a Batch Run ID from a full id or unique prefix.
 *
 * Mirrors `resolveRunId` for batches: full ids pass through, shorter inputs
 * are matched against the batch list (`--project` scoped when configured).
 */
export async function resolveBatchId(
  backendUrl: string,
  prefix: string,
  config: Config,
): Promise<string> {
  const params: Record<string, string> = {};
  if (config.projectId) params.project = config.projectId;

  // The backend returns a paginated payload ({data: [...]}); accept a bare
  // array from older deployments too.
  const payload = await apiGet<
    Array<{ id: string }> | { data: Array<{ id: string }> }
  >(backendUrl, "/v1/agent-task-batch-runs", params, config);
  const batches = Array.isArray(payload) ? payload : payload.data;
  const result = findByPrefix(batches, prefix, (b) => b.id);
  if (result.status === "none") {
    throw new Error(`Backend error 404: {"detail":"Batch run not found"}`);
  }
  if (result.status === "ambiguous") {
    throw new Error(
      `Batch ID prefix "${prefix}" matches multiple batches: ${result.items
        .map((b) => b.id)
        .join(", ")}`,
    );
  }
  return result.item.id;
}
