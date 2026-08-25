import type { JudgeConfig } from "../checks/t.ts";

export type TaskDefinition<
  TAdapterName extends string = string,
  TDeliverable extends string = string,
> = {
  id: string;
  adapter: TAdapterName;
  description?: string;
  deliverables: TDeliverable[];
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  checks?: string | false;
  /**
   * Task-level judge layer (#161): overrides the run-level `runTask({ judge })`
   * config and is itself overridden per `t.judge` call. Lets a task grade
   * differently from its suite — a stronger model, or a custom briefing via
   * `prompt` that tells the judge what it is grading.
   */
  judge?: Partial<JudgeConfig>;
};

export type TaskConfig<TDeliverable extends string = string> = Omit<
  TaskDefinition<string, TDeliverable>,
  "adapter"
>;

export type FileEntry = {
  relativePath: string;
  absolutePath: string;
};
