/**
 * SPEC-161: Canonical catalog digest for TypeScript.
 *
 * Must produce the exact same digest as the Python compute_catalog_digest.
 * Uses stable key ordering and compact JSON.
 */

import { createHash } from "node:crypto";
import type { PublishedTask } from "./task-catalog.ts";

export function computeCatalogDigest(tasks: PublishedTask[]): string {
  const normalized = tasks
    .map((t) => ({
      task_id: t.task_id,
      display_name: t.display_name,
      task_path: t.task_path,
      folder_path: t.folder_path,
      adapter_name: t.adapter_name,
      has_checks: t.has_checks,
      has_user_simulator: t.has_user_simulator,
      tags: [...t.tags].sort(),
    }))
    .sort((a, b) => a.task_id.localeCompare(b.task_id));

  const doc = { schema_version: 1, tasks: normalized };
  const payload = JSON.stringify(doc)
    .replace(/,/g, ",")
    .replace(/:/g, ":");
  // Compact JSON matching Python's separators=(",",":")
  return "sha256:" + createHash("sha256").update(payload).digest("hex");
}
