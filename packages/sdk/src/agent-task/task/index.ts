export type {
  TaskDefinition,
  TaskConfig,
  FileEntry,
} from "./types.ts";

export {
  defineTask,
  task,
  resetTaskRegistry,
  type TaskScope,
} from "./defineTask.ts";
export { loadTask, type LoadedTask } from "./loadTask.ts";
export { TaskFiles } from "./TaskFiles.ts";
