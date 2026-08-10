/**
 * analytics-report Adapter — the thin bridge between apo and the agent.
 *
 * Owns no agent logic. Hands each turn to the implementation
 * (`./implementation/analytics-report-agent.ts`) and shapes the session into
 * the `{ result, tool_log, stats }` deliverables. The implementation calls the
 * real example-service `handleChat()`.
 */
import { defineAdapter, registerApoTracing } from "@apo-ai/sdk/agent-task";
import type { FileEntry } from "@apo-ai/sdk/agent-task";
import { readFileSync } from "fs";
import { z } from "zod";
import { runAnalyticsReport } from "./implementation/analytics-report-agent.ts";

await registerApoTracing();

// Deliverable schemas — the validated shape shared with the canonical example
// service. Not a video-only format.
const deliverableSchemas = {
  result: z.object({
    summary: z.string(),
    findings: z.array(z.string()),
  }),
  tool_log: z.object({
    total_calls: z.number(),
    tools_used: z.array(z.string()),
    details: z.array(z.any()),
  }),
  stats: z.object({
    turn_count: z.number(),
    file_count: z.number(),
    total_tool_calls: z.number(),
    unique_tools: z.array(z.string()),
  }),
} as const;

type TrackedToolCall = {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
};

type SessionState = {
  turnCount: number;
  allToolCalls: TrackedToolCall[];
  fileContents: Record<string, string>;
  agentResponses: string[];
};

const EMPTY_STATE: SessionState = {
  turnCount: 0,
  allToolCalls: [],
  fileContents: {},
  agentResponses: [],
};

function loadFiles(files: FileEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of files) out[f.relativePath] = readFileSync(f.absolutePath, "utf-8");
  return out;
}

export const analyticsReportAdapter = defineAdapter({
  name: "analytics-report",
  deliverables: deliverableSchemas,

  turn: async ({ files, transcript }) => {
    if (transcript.length > 0) return null;
    try {
      return await files.read("instructions.md");
    } catch {
      return "Produce an evidence-grounded product analytics report from metrics.json.";
    }
  },

  async initialize(ctx) {
    return { ...EMPTY_STATE, fileContents: loadFiles(ctx.files) };
  },

  async startSession(ctx) {
    const state: SessionState = (ctx.state ?? EMPTY_STATE) as SessionState;
    // Report the same resolved model the implementation uses.
    const model = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash-0731";
    return {
      runConfiguration: { model },
      async sendUserTurn(turn: unknown) {
        state.turnCount++;
        const fileList = Object.keys(state.fileContents).map((f) => `- ${f}`).join("\n");
        const result = await runAnalyticsReport({
          prompt: `${turn}\n\nAvailable files:\n${fileList}`,
          files: state.fileContents,
          taskDir: ctx.taskDir,
        });
        state.agentResponses.push(result.response);
        state.allToolCalls.push(...result.tool_calls);
        return { response: result.response };
      },
    };
  },

  async collectDeliverables(ctx) {
    const state: SessionState = (ctx.state ?? EMPTY_STATE) as SessionState;
    const lastResponse = state.agentResponses[state.agentResponses.length - 1] ?? "";
    const uniqueTools = [...new Set(state.allToolCalls.map((tc) => tc.tool))];
    return {
      result: {
        summary: lastResponse.slice(0, 500) || "Agent completed task",
        findings: state.allToolCalls
          .filter((tc) => tc.tool === "compute")
          .map((tc) => `${tc.args.expression ?? ""} = ${JSON.stringify(tc.result)}`),
      },
      tool_log: {
        total_calls: state.allToolCalls.length,
        tools_used: uniqueTools,
        details: state.allToolCalls,
      },
      stats: {
        turn_count: state.turnCount,
        file_count: ctx.files.length,
        total_tool_calls: state.allToolCalls.length,
        unique_tools: uniqueTools,
      },
    };
  },
});
