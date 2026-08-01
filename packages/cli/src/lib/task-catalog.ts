/**
 * Client-published Task Catalog types.
 *
 * The CLI scans Tasks locally and publishes only bounded dashboard metadata.
 * Source files, prompts, fixtures, repository credentials, and absolute
 * paths never cross the publication boundary.
 */

export type PublishedTask = {
  task_id: string;
  display_name: string;
  task_path: string;
  folder_path: string;
  adapter_name: string;
  has_checks: boolean;
  has_user_simulator: boolean;
  tags: string[];
};

export type PublishTaskCatalogRequest = {
  schema_version: 1;
  tasks: PublishedTask[];
};

export type TaskCatalog = {
  project: string;
  schema_version: 1;
  task_count: number;
  catalog_digest: string;
  published_at: string;
  execution_mode: "caller" | "bundled_demo";
};

/**
 * Map discovered TaskMeta to the publication allowlist.
 * Strips all source-derived data (absolute paths, files, deliverables, etc.).
 */
export function toPublishedTask(meta: {
  id: string;
  folderPath: string;
  adapter: string;
  hasChecks: boolean;
  hasSimulator: boolean;
}): PublishedTask {
  const segments = meta.id.split("/");
  const displayName = segments[segments.length - 1];
  return {
    task_id: meta.id,
    display_name: displayName,
    task_path: meta.id,
    folder_path: meta.folderPath,
    adapter_name: meta.adapter,
    has_checks: meta.hasChecks,
    has_user_simulator: meta.hasSimulator,
    tags: [],
  };
}
