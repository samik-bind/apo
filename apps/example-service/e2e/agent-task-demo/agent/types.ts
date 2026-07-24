/**
 * Shared types for the example agent.
 *
 * Agent-level concerns — they describe what the agent tracks and produces,
 * not how apo runs it. The deliverable schemas + parsers that used to live
 * here have moved to `../lib/deliverables.ts`.
 */

/** A single tool call the agent made, tracked for the deliverable report. */
export type TrackedToolCall = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
};

/** State accumulated across turns within one session. */
export type AgentState = {
  turnCount: number;
  allToolCalls: TrackedToolCall[];
  fileContents: Record<string, string>;
  agentResponses: string[];
};
