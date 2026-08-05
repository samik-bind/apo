import type { FileEntry, TaskDefinition } from "../task/types.ts";
import type { AgentTaskTraceContext } from "../tracing.ts";
import type { TurnFn } from "../turn.ts";

export type ValidatableSchemaLike = {
  safeParse: (data: unknown) => {
    success: boolean;
    error?: { message: string };
  };
};

export type DeliverableDefinition =
  | ValidatableSchemaLike
  | {
      schema?: ValidatableSchemaLike;
    }
  | null;

export type CollectedDeliverables = Record<string, unknown>;

export type AgentTurnResult = {
  response: unknown;
};

/**
 * The adapter-reported identity of the agent under test for one Task Run
 * The adapter resolves its configuration (env vars, aliases,
 * defaults), constructs the agent from that same resolved object, and reports
 * the resolved values here.
 *
 * - `model` is the exact identifier the adapter passed to its runtime.
 * - `effort` is the exact short value that the selected model/provider applied
 *   (`low`/`medium`/... or `"default"`). Omit it when effort is unsupported,
 *   ignored, or cannot be verified. A configured default or accepted request
 *   parameter is not an applied effort by itself.
 *
 * The whole configuration is absent (`undefined`) when the adapter does not
 * support reporting it. Values are descriptive — they never affect task
 * selection, execution, scoring, retry, or deduplication.
 */
export interface AgentTaskRunConfiguration {
  model: string;
  effort?: string;
}

export type AdapterRuntimeState = Record<string, unknown>;

export type InitializeContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  trace: AgentTaskTraceContext;
};

export type StartSessionContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  trace: AgentTaskTraceContext;
};

export type CollectDeliverablesContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  session: AdapterSession;
  trace: AgentTaskTraceContext;
};

export type CleanupContext = {
  task: TaskDefinition;
  taskDir: string;
  files: FileEntry[];
  state?: AdapterRuntimeState;
  session?: AdapterSession;
  trace: AgentTaskTraceContext;
};

export type AdapterSession = {
  /**
   * The adapter's resolved model/effort for this run. Read by
   * `runTask()` immediately after `startSession()` returns, validated, and
   * copied into {@link TaskRunResult.runConfiguration}. Absent for adapters
   * that do not report configuration.
   */
  runConfiguration?: AgentTaskRunConfiguration;
  sendUserTurn: (
    turn: unknown,
    context: {
      trace: AgentTaskTraceContext;
      turnNumber: number;
      parentSpanId?: string;
    },
  ) => Promise<AgentTurnResult>;
  close?: () => Promise<void>;
};

export type AdapterDefinition = {
  name: string;
  deliverables: Record<string, DeliverableDefinition>;
  turn?: TurnFn;
  initialize?: (ctx: InitializeContext) => Promise<AdapterRuntimeState | void>;
  startSession: (ctx: StartSessionContext) => Promise<AdapterSession>;
  collectDeliverables: (
    ctx: CollectDeliverablesContext,
  ) => Promise<CollectedDeliverables>;
  cleanup?: (ctx: CleanupContext) => Promise<void>;
};

export type TypedAdapterDefinition<
  TName extends string,
  TDeliverables extends Record<string, DeliverableDefinition>,
  TCollected extends CollectedDeliverables = CollectedDeliverables,
> = Omit<
  AdapterDefinition,
  "name" | "deliverables" | "collectDeliverables"
> & {
  name: TName;
  deliverables: TDeliverables;
  collectDeliverables: (
    ctx: CollectDeliverablesContext,
  ) => Promise<TCollected>;
};
