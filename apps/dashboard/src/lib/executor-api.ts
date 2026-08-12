import { apiClient } from "./api-client";

export interface ExecutorPoolSummary {
  id: string;
  name: string;
  slug: string;
  kind: string;
  enabled: boolean;
  archived: boolean;
  is_default: boolean;
  health: "online" | "busy" | "offline" | "disabled" | "incompatible";
  online_executor_count: number;
  available_capacity: number;
  queue_ttl_seconds: number;
  required_driver_kind: string;
}

interface ExecutorPoolListResponse {
  pools: ExecutorPoolSummary[];
}

export async function listExecutorPools(
  projectId: string,
  signal?: AbortSignal,
): Promise<ExecutorPoolSummary[]> {
  const response = await apiClient<ExecutorPoolListResponse>(
    `/v1/projects/${encodeURIComponent(projectId)}/executor-pools`,
    { cache: "no-store", signal },
  );
  return response.pools;
}
