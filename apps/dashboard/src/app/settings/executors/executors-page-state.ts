import type {
  EnrollmentTokenResponse,
  ExecutorPoolSummary,
  ExecutorSummary,
} from "@/lib/executor-api";
import type { Project } from "@/lib/projects-api";

export interface ExecutorsPageState {
  projects: Project[];
  projectId: string;
  role: string | null;
  pools: ExecutorPoolSummary[];
  executors: ExecutorSummary[];
  selectedPoolId: string;
  loading: boolean;
  busy: boolean;
  error: string | null;
  showCreate: boolean;
  enrollment: EnrollmentTokenResponse | null;
  editingPool: ExecutorPoolSummary | null;
  renamingExecutor: ExecutorSummary | null;
}

export type ExecutorsPageAction =
  | { type: "projects-loaded"; projects: Project[] }
  | { type: "project-selected"; projectId: string }
  | { type: "loading"; loading: boolean }
  | {
    type: "executor-state-loaded";
    role: string | null;
    pools: ExecutorPoolSummary[];
    executors: ExecutorSummary[];
  }
  | { type: "failed"; error: string }
  | { type: "busy"; busy: boolean }
  | { type: "pool-selected"; poolId: string }
  | { type: "create-dialog"; open: boolean }
  | { type: "enrollment"; enrollment: EnrollmentTokenResponse | null }
  | { type: "edit-pool"; pool: ExecutorPoolSummary | null }
  | { type: "rename-executor"; executor: ExecutorSummary | null };

export const INITIAL_EXECUTORS_PAGE_STATE: ExecutorsPageState = {
  projects: [],
  projectId: "",
  role: null,
  pools: [],
  executors: [],
  selectedPoolId: "",
  loading: true,
  busy: false,
  error: null,
  showCreate: false,
  enrollment: null,
  editingPool: null,
  renamingExecutor: null,
};

export function executorsPageReducer(
  state: ExecutorsPageState,
  action: ExecutorsPageAction,
): ExecutorsPageState {
  switch (action.type) {
    case "projects-loaded":
      return {
        ...state,
        projects: action.projects,
        projectId: state.projectId || action.projects[0]?.id || "",
      };
    case "project-selected":
      return {
        ...state,
        projectId: action.projectId,
        selectedPoolId: "",
        role: null,
      };
    case "loading":
      return {
        ...state,
        loading: action.loading,
        error: action.loading ? null : state.error,
      };
    case "executor-state-loaded":
      return loadExecutorState(state, action);
    case "failed":
      return { ...state, error: action.error, loading: false };
    case "busy":
      return {
        ...state,
        busy: action.busy,
        error: action.busy ? null : state.error,
      };
    case "pool-selected":
      return { ...state, selectedPoolId: action.poolId };
    case "create-dialog":
      return { ...state, showCreate: action.open };
    case "enrollment":
      return { ...state, enrollment: action.enrollment };
    case "edit-pool":
      return { ...state, editingPool: action.pool };
    case "rename-executor":
      return { ...state, renamingExecutor: action.executor };
  }
}

function loadExecutorState(
  state: ExecutorsPageState,
  action: Extract<ExecutorsPageAction, { type: "executor-state-loaded" }>,
): ExecutorsPageState {
  const selectedPoolId = action.pools.some(
    (pool) => pool.id === state.selectedPoolId,
  )
    ? state.selectedPoolId
    : action.pools.find((pool) => pool.is_default)?.id
      ?? action.pools[0]?.id
      ?? "";
  return {
    ...state,
    role: action.role,
    pools: action.pools,
    executors: action.executors,
    selectedPoolId,
  };
}
