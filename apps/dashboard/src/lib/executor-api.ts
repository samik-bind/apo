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

export function getDefaultExecutorPool(
  pools: ExecutorPoolSummary[],
): ExecutorPoolSummary | null {
  return pools.find((pool) => pool.is_default && isSelectableExecutorPool(pool)) ?? null;
}

export function isSelectableExecutorPool(pool: ExecutorPoolSummary): boolean {
  return pool.enabled && !pool.archived;
}

export interface ExecutorSummary {
  id: string;
  pool_id: string;
  name: string;
  status: string;
  executor_version: string;
  protocol_version: number;
  driver_kinds: string[];
  os: string;
  architecture: string;
  max_concurrency: number;
  active_attempts: number;
  last_seen_at: string | null;
  enrolled_at: string;
}

export interface EnrollmentTokenResponse {
  id: string;
  pool_id: string;
  token: string;
  expires_at: string;
  container: {
    image: string;
    command: string[];
    environment: Record<string, string>;
    state_volume: string;
  };
}

export const listExecutors = async (
  projectId: string,
  signal?: AbortSignal,
): Promise<ExecutorSummary[]> => {
  const response = await apiClient<{ executors: ExecutorSummary[] }>(
    `/v1/projects/${encodeURIComponent(projectId)}/executors`,
    { cache: "no-store", signal },
  );
  return response.executors;
};

export const createExecutorPool = (
  projectId: string,
  body: { name: string; slug: string; queue_ttl_seconds: number },
): Promise<ExecutorPoolSummary> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/executor-pools`, {
    method: "POST",
    body: { ...body, kind: "connected", required_driver_kind: "subprocess" },
  });

export const setDefaultExecutorPool = (
  projectId: string,
  poolId: string,
): Promise<void> =>
  apiClient(`/v1/projects/${encodeURIComponent(projectId)}/default-executor-pool`, {
    method: "PUT",
    body: { pool_id: poolId },
  });

export const createEnrollmentToken = (
  projectId: string,
  poolId: string,
): Promise<EnrollmentTokenResponse> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/executor-pools/${encodeURIComponent(poolId)}/enrollment-tokens`,
    { method: "POST" },
  );

export const revokeEnrollmentToken = (
  projectId: string,
  poolId: string,
  tokenId: string,
): Promise<void> =>
  apiClient(
    (
      `/v1/projects/${encodeURIComponent(projectId)}` +
      `/executor-pools/${encodeURIComponent(poolId)}` +
      `/enrollment-tokens/${encodeURIComponent(tokenId)}`
    ),
    { method: "DELETE" },
  );

export const patchExecutorPool = (
  projectId: string,
  poolId: string,
  body: { enabled?: boolean; queue_ttl_seconds?: number; name?: string },
): Promise<ExecutorPoolSummary> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/executor-pools/${encodeURIComponent(poolId)}`,
    { method: "PATCH", body },
  );

export const archiveExecutorPool = (
  projectId: string,
  poolId: string,
): Promise<void> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/executor-pools/${encodeURIComponent(poolId)}`,
    { method: "DELETE" },
  );

export const revokeExecutor = (
  projectId: string,
  executorId: string,
): Promise<void> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/executors/${encodeURIComponent(executorId)}/revoke`,
    { method: "POST", body: {} },
  );

export const renameExecutor = (
  projectId: string,
  executorId: string,
  name: string,
): Promise<void> =>
  apiClient(
    `/v1/projects/${encodeURIComponent(projectId)}/executors/${encodeURIComponent(executorId)}/rename`,
    { method: "POST", body: { name } },
  );
