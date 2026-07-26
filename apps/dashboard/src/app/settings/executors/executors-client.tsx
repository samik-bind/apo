"use client";

import { useCallback, useEffect, useReducer } from "react";
import { Plus } from "lucide-react";
import {
  archiveExecutorPool,
  createEnrollmentToken,
  createExecutorPool,
  listExecutorPools,
  listExecutors,
  patchExecutorPool,
  renameExecutor,
  revokeEnrollmentToken,
  revokeExecutor,
  setDefaultExecutorPool,
} from "@/lib/executor-api";
import { getProject, listProjects } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { CreatePoolDialog } from "./create-pool-dialog";
import { EditPoolDialog } from "./edit-pool-dialog";
import { EnrollmentDialog } from "./enrollment-dialog";
import { ExecutorList } from "./executor-list";
import { PoolList } from "./pool-list";
import { RenameExecutorDialog } from "./rename-executor-dialog";
import { INITIAL_EXECUTORS_PAGE_STATE, executorsPageReducer } from "./executors-page-state";

export function ExecutorsClient() {
  const [state, dispatch] = useReducer(executorsPageReducer, INITIAL_EXECUTORS_PAGE_STATE);
  const {
    projects,
    projectId,
    role,
    pools,
    executors,
    selectedPoolId,
    loading,
    busy,
    error,
    showCreate,
    enrollment,
    editingPool,
    renamingExecutor,
  } = state;

  useEffect(() => {
    const controller = new AbortController();
    listProjects(controller.signal)
      .then((items) => {
        const writable = items.filter((project) => project.id !== "demo");
        dispatch({ type: "projects-loaded", projects: writable });
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({
            type: "failed",
            error: caught instanceof Error ? caught.message : "Failed to load projects",
          });
        }
      });
    return () => controller.abort();
  }, []);

  const loadProject = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) {
      dispatch({ type: "loading", loading: false });
      return;
    }
    dispatch({ type: "loading", loading: true });
    try {
      const [project, nextPools, nextExecutors] = await Promise.all([
        getProject(projectId, signal),
        listExecutorPools(projectId, signal),
        listExecutors(projectId, signal),
      ]);
      if (signal?.aborted) return;
      dispatch({
        type: "executor-state-loaded",
        role: project.current_user_role,
        pools: nextPools,
        executors: nextExecutors,
      });
    } catch (caught: unknown) {
      if (!signal?.aborted) {
        dispatch({
          type: "failed",
          error: caught instanceof Error ? caught.message : "Failed to load Executors",
        });
      }
    } finally {
      if (!signal?.aborted) dispatch({ type: "loading", loading: false });
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadProject(controller.signal);
    return () => controller.abort();
  }, [loadProject]);

  const mutate = async (action: () => Promise<unknown>) => {
    dispatch({ type: "busy", busy: true });
    try {
      await action();
      await loadProject();
    } catch (caught: unknown) {
      dispatch({
        type: "failed",
        error: caught instanceof Error ? caught.message : "Executor operation failed",
      });
    } finally {
      dispatch({ type: "busy", busy: false });
    }
  };

  const canManage = role === "owner" || role === "admin";
  const canArchive = role === "owner";

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <label
            htmlFor="executor-project"
            className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            Project
          </label>
          <select
            id="executor-project"
            value={projectId}
            onChange={(event) => dispatch(
              { type: "project-selected", projectId: event.target.value },
            )}
            className="flex h-8 min-w-56 border border-input bg-transparent px-2.5 text-[12px] outline-none focus:border-ring"
          >
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        {canManage && (
          <Button type="button" size="sm" onClick={() => dispatch({ type: "create-dialog", open: true })}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Create Pool
          </Button>
        )}
      </div>

      {error && (
        <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-[12px] text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-[12px] text-muted-foreground">Loading Executor state…</p>
      ) : (
        <>
          <PoolList
            pools={pools}
            selectedPoolId={selectedPoolId}
            canManage={canManage}
            canArchive={canArchive}
            busy={busy}
            onSelect={(poolId) => dispatch({ type: "pool-selected", poolId })}
            onSetDefault={(pool) => void mutate(() => setDefaultExecutorPool(projectId, pool.id))}
            onCreateToken={(pool) => {
              dispatch({ type: "busy", busy: true });
              createEnrollmentToken(projectId, pool.id)
                .then((value) => dispatch({ type: "enrollment", enrollment: value }))
                .catch((caught: unknown) => dispatch({
                  type: "failed",
                  error: caught instanceof Error ? caught.message : "Failed to create token",
                }))
                .finally(() => dispatch({ type: "busy", busy: false }));
            }}
            onEdit={(pool) => dispatch({ type: "edit-pool", pool })}
            onToggle={(pool) => void mutate(() => patchExecutorPool(projectId, pool.id, { enabled: !pool.enabled }))}
            onArchive={(pool) => {
              if (window.confirm(`Archive ${pool.name}? Its schedules will be disabled and it cannot accept new work.`)) {
                void mutate(() => archiveExecutorPool(projectId, pool.id));
              }
            }}
          />
          {selectedPoolId && (
            <ExecutorList
              executors={executors}
              poolId={selectedPoolId}
              canManage={canManage}
              busy={busy}
              onRename={(executor) => dispatch({ type: "rename-executor", executor })}
              onRevoke={(executor) => {
                if (window.confirm(`Revoke ${executor.name}? Running work becomes lost and cannot be proven stopped.`)) {
                  void mutate(() => revokeExecutor(projectId, executor.id));
                }
              }}
            />
          )}
          <div className="border border-border bg-muted/20 p-3 text-[11px] leading-relaxed text-muted-foreground">
            Bundled Executors run as a separate trusted apo process. Connected Executors run in your environment using outbound HTTPS.
            The subprocess driver separates Tasks from the API process, but it is not a hostile-code sandbox.
          </div>
        </>
      )}

      {showCreate && (
        <CreatePoolDialog
          busy={busy}
          onClose={() => dispatch({ type: "create-dialog", open: false })}
          onCreate={(body) => void mutate(async () => {
            const pool = await createExecutorPool(projectId, body);
            dispatch({ type: "pool-selected", poolId: pool.id });
            dispatch({ type: "create-dialog", open: false });
          })}
        />
      )}
      {enrollment && (
        <EnrollmentDialog
          enrollment={enrollment}
          busy={busy}
          onClose={() => dispatch({ type: "enrollment", enrollment: null })}
          onRevoke={() => void mutate(async () => {
            await revokeEnrollmentToken(projectId, enrollment.pool_id, enrollment.id);
            dispatch({ type: "enrollment", enrollment: null });
          })}
        />
      )}
      {editingPool && (
        <EditPoolDialog
          pool={editingPool}
          busy={busy}
          onClose={() => dispatch({ type: "edit-pool", pool: null })}
          onSave={(patch) => void mutate(async () => {
            await patchExecutorPool(projectId, editingPool.id, patch);
            dispatch({ type: "edit-pool", pool: null });
          })}
        />
      )}
      {renamingExecutor && (
        <RenameExecutorDialog
          executor={renamingExecutor}
          busy={busy}
          onClose={() => dispatch({ type: "rename-executor", executor: null })}
          onRename={(name) => void mutate(async () => {
            await renameExecutor(projectId, renamingExecutor.id, name);
            dispatch({ type: "rename-executor", executor: null });
          })}
        />
      )}
    </div>
  );
}
