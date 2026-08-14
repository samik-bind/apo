"use client";

import { useMemo, useState } from "react";
import type { FolderNode } from "./task-list-shared";

/**
 * Selection state for the task list: single tasks, whole folders, and the
 * root select-all. The select-all checkbox targets exactly the tasks visible
 * under the active filters, leaving ids selected outside the filter
 * untouched (same rule as folder toggles).
 */
export function useTaskSelection({ folders }: { folders: FolderNode[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visibleTaskIds = useMemo(
    () => folders.flatMap((f) => f.tasks.map((t) => t.id)),
    [folders],
  );
  const visibleSelectedCount = visibleTaskIds.filter((id) => selected.has(id)).length;
  const selectAllState: "none" | "some" | "all" =
    visibleSelectedCount === 0 ? "none"
    : visibleSelectedCount === visibleTaskIds.length ? "all"
    : "some";

  const toggleTask = (taskId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

  const toggleFolder = (folder: FolderNode) => {
    const ids = folder.tasks.map((t) => t.id);
    const allSelected = ids.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleSelectAll = () => {
    const allSelected = visibleTaskIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) visibleTaskIds.forEach((id) => next.delete(id));
      else visibleTaskIds.forEach((id) => next.add(id));
      return next;
    });
  };

  return {
    selected,
    setSelected,
    toggleTask,
    toggleFolder,
    toggleSelectAll,
    selectAllState,
    visibleTaskIds,
  };
}
