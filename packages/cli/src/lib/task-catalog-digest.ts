/**
 * Canonical catalog digest for TypeScript.
 *
 * Must produce the exact same digest as the Python compute_catalog_digest,
 * which uses ``json.dumps(doc, sort_keys=True, separators=(",", ":"))``.
 * That sorts keys recursively inside each task object, so we canonicalize with
 * the same recursive key ordering before compact serialization.
 */

import { createHash } from "node:crypto";
import type { PublishedTask } from "./task-catalog.ts";

function stableCanonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableCanonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = stableCanonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function computeCatalogDigest(tasks: PublishedTask[]): string {
  const normalized = tasks
    .map((t) => ({
      task_id: t.task_id,
      display_name: t.display_name,
      task_path: t.task_path,
      folder_path: t.folder_path,
      adapter_name: t.adapter_name,
      has_checks: t.has_checks,
      tags: [...t.tags].sort(),
    }))
    .sort((a, b) => a.task_id.localeCompare(b.task_id));

  // Compact JSON with recursively sorted keys, matching Python's
  // separators=(",", ":") + sort_keys=True.
  const payload = JSON.stringify(stableCanonicalize({ schema_version: 1, tasks: normalized }));
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}

