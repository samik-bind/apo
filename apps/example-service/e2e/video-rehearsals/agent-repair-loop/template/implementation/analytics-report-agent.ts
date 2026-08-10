/**
 * analytics-report agent implementation — the ONLY file a coding agent may edit
 * during a Repair Trial.
 *
 * INTENTIONAL REHEARSAL DEFECT
 * ----------------------------
 * This file is copied into a disposable `work/` directory and is intentionally
 * incomplete. It calls the real example-service `handleChat()` but with a step
 * budget (`maxSteps: 2`) that allows `list_files` and `read_file` while
 * preventing the required `compute` step. The Golden Task's trajectory check
 * therefore fails on a fresh workspace — that failure is the visible gap the
 * coding agent must close.
 *
 * The intended repair is general orchestration behavior (a sufficient step
 * budget and a clear calculation policy), NOT a hardcoded report. Do not embed
 * fixture-specific metric values (840, 42%, 126000, ...) in implementation
 * code — the report must come from running the agent, not from literals here.
 */

import { handleChat, type ChatRequest } from "../../../../../app/lib/agent/service.ts";

/** System prompt: force file-grounded, computed, verifiable answers. */
const REPORT_SYSTEM_PROMPT =
  "You are a product analytics agent with access to tools. " +
  "Always use list_files first, then read_file for the exact paths shown. " +
  "Never answer from assumptions or memory. " +
  "For every derived metric (growth, retention), call the compute tool with the " +
  "exact arithmetic and state the computed result. Do not do arithmetic in your head. " +
  "Quote each metric with its label so distinct figures (active-user growth, " +
  "revenue growth, retention) are unambiguous. " +
  "Do not invent causal explanations — only state what the supplied metrics support.";

export type AnalyticsReportInput = {
  prompt: string;
  files: Record<string, string>;
  taskDir?: string;
};

export type AnalyticsReportOutput = {
  response: string;
  tool_calls: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: unknown;
  }>;
  usage: { input_tokens: number; output_tokens: number } | null;
};

/**
 * Run the analytics-report agent for one turn.
 *
 * Passes the Task-provided prompt and files straight through to the real
 * `handleChat()`. Contains no hardcoded expected metrics.
 */
export async function runAnalyticsReport(
  input: AnalyticsReportInput,
): Promise<AnalyticsReportOutput> {
  const messages: ChatRequest["messages"] = [
    { role: "user", content: input.prompt },
  ];

  const result = await handleChat({
    messages,
    files: input.files,
    taskDir: input.taskDir,
    system: REPORT_SYSTEM_PROMPT,
    // INTENTIONAL REHEARSAL DEFECT: maxSteps: 2 lets the agent call list_files
    // and read_file, but the run stops before the required `compute` step.
    // Raise this budget (and ensure a clear calculation policy) so the report
    // workflow can complete.
    maxSteps: 2,
  });

  return {
    response: result.response,
    tool_calls: result.tool_calls,
    usage: result.usage,
  };
}
