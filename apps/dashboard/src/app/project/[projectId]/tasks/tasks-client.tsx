"use client";

import { useMemo, useState } from "react";
import { type AgentTaskSummary } from "@/lib/agent-task-api";
import { Button } from "@/components/ui/button";

import { useProjectId, useIsDemo } from "@/lib/project-router";
import type { ProjectTaskSource } from "@/lib/projects-api";

import { EvidenceViewsBar } from "./components/EvidenceViewsBar";
import { FolderList } from "./components/FolderList";
import { SelectionActionBar } from "./components/SelectionActionBar";
import { TasksToolbar } from "./components/TasksToolbar";
import { useEvidenceViews } from "./components/use-evidence-views";
import { useTaskSelection } from "./components/use-task-selection";
import { useTaskRunActions } from "./components/use-task-run-actions";
import {
  groupByFolder,
  STATUS_FILTER_KEYS,
  taskFilterStatus,
} from "./components/task-list-shared";

interface AgentTasksClientProps {
  tasks: AgentTaskSummary[];
  error: string | null;
  taskSource: ProjectTaskSource | null;
  isDemo: boolean;
}

export function AgentTasksClient({
  tasks,
  error,
  taskSource,
  isDemo,
}: AgentTasksClientProps) {
  const projectId = useProjectId();
  const clientIsDemo = useIsDemo();
  const isDemoProject = isDemo || clientIsDemo;
  const [editingSource, setEditingSource] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const folders = groupByFolder(tasks);
    return new Set(folders.map((f) => f.id));
  });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(() => new Set(STATUS_FILTER_KEYS));

  const {
    views,
    activeView,
    activeViewId,
    setActiveViewId,
    facets,
    addingTab,
    viewStatsLoading,
    effectiveTasks,
    updateActiveView,
    duplicateActive,
    closeView,
  } = useEvidenceViews({ projectId, isDemoProject, tasks });

  const statusFilteredTasks = useMemo<AgentTaskSummary[]>(() => {
    if (statusFilter.size === STATUS_FILTER_KEYS.length) return effectiveTasks;
    return effectiveTasks.filter((t) => statusFilter.has(taskFilterStatus(t)));
  }, [effectiveTasks, statusFilter]);

  const folders = useMemo(() => groupByFolder(statusFilteredTasks), [statusFilteredTasks]);

  const filtered = useMemo(() => {
    if (!query) return folders;
    const q = query.toLowerCase();
    return folders.reduce<typeof folders>((acc, f) => {
      const fm = f.id.toLowerCase().includes(q);
      const fTasks = fm ? f.tasks : f.tasks.filter((t) => t.display_name.toLowerCase().includes(q) || t.task_path.toLowerCase().includes(q));
      if (fTasks.length > 0) acc.push({ ...f, tasks: fTasks });
      return acc;
    }, []);
  }, [query, folders]);

  const {
    selected,
    setSelected,
    toggleTask,
    toggleFolder,
    toggleSelectAll,
    selectAllState,
    visibleTaskIds,
  } = useTaskSelection({ folders: filtered });

  const {
    syncing,
    handleSync,
    runState,
    handleRun,
    comparing,
    handleCompare,
  } = useTaskRunActions({
    projectId,
    isDemoProject,
    taskSource,
    tasks,
    selected,
    activeView,
  });

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allFolderIds = folders.map((f) => f.id);
  const allExpanded = allFolderIds.length > 0 && allFolderIds.every((id) => expanded.has(id));

  // Non-demo projects only replace the task list with setup UI when
  // there is no configured source or the persisted inventory belongs
  // to an older source root/ref/subpath. Other source states keep the
  // task list visible so routine resyncs do not hide valid tasks.
  const sourceNeedsAttention =
    taskSource?.inventory_stale === true;
  const showSetupCard =
    !isDemoProject &&
    !error &&
    (taskSource === null || sourceNeedsAttention);

  return (
    <div className="flex flex-col">
      {editingSource && taskSource && !isDemoProject ? (
        <div className="border-b border-border px-6 py-10">
          <div className="mx-auto max-w-2xl">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setEditingSource(false)}
            >
              Done
            </Button>
          </div>
        </div>
      ) : showSetupCard ? (
        <div className="px-6 py-10">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 text-center">
            <p className="text-sm text-neutral-400">
              Run <code className="text-neutral-200">apo task publish</code> to publish your task catalog.
            </p>
          </div>
        </div>
      ) : (
        <>
          <TasksToolbar
            taskSource={taskSource}
            isDemoProject={isDemoProject}
            editingSource={editingSource}
            syncing={syncing}
            selectedCount={selected.size}
            runRunning={runState.running}
            onEditSource={() => setEditingSource(true)}
            onSync={handleSync}
            onRun={handleRun}
          />
          {tasks.length > 0 && (
            <EvidenceViewsBar
              views={views}
              activeViewId={activeViewId}
              facets={facets}
              loading={viewStatsLoading}
              isDerived={activeView.model !== null || activeView.effort !== null}
              viewsActive={!isDemoProject}
              addingTab={addingTab}
              query={query}
              onQueryChange={setQuery}
              selectedCount={selected.size}
              onClearSelection={() => setSelected(new Set())}
              onToggleExpandAll={() => setExpanded(allExpanded ? new Set() : new Set(allFolderIds))}
              allExpanded={allExpanded}
              statusFilter={statusFilter}
              onToggleStatus={(key) =>
                setStatusFilter((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) {
                    next.delete(key);
                    if (next.size === 0) return new Set(STATUS_FILTER_KEYS); // don't allow empty
                  } else {
                    next.add(key);
                  }
                  return next;
                })
              }
              onSelect={setActiveViewId}
              onChange={updateActiveView}
              onDuplicate={duplicateActive}
              onClose={closeView}
            />
          )}

      {/* Error alerts */}
      {(error || runState.error) && (
        <div className="mx-6 mt-4 border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
          {error || runState.error}
        </div>
      )}

      {/* Empty state */}
      {!error && tasks.length === 0 && (
        <div className="m-6 border border-dashed border-border bg-muted/10 p-10 text-center text-[13px] text-muted-foreground">
          No agent tasks discovered. Ensure the task root directory is configured.
        </div>
      )}

      {/* Folder list */}
      <FolderList
        folders={filtered}
        expanded={expanded}
        selected={selected}
        query={query}
        selectAllState={selectAllState}
        visibleTaskCount={visibleTaskIds.length}
        onToggleSelectAll={toggleSelectAll}
        onToggleFolder={toggleFolder}
        onToggleTask={toggleTask}
        onToggleExpand={toggleExpand}
      />

      {/* Sticky bottom action bar */}
      {selected.size > 0 && (
        <SelectionActionBar
          selectedCount={selected.size}
          runRunning={runState.running}
          comparing={comparing}
          isDemoProject={isDemoProject}
          compareOptions={[
            ...facets.flatMap((f) =>
              f.model !== activeView.model ? [{ model: f.model, label: f.model }] : [],
            ),
            ...(activeView.model !== null ? [{ model: null as string | null, label: "All models" }] : []),
          ]}
          onClear={() => setSelected(new Set())}
          onRun={handleRun}
          onCompare={handleCompare}
        />
      )}
        </>
      )}
    </div>
  );
}
