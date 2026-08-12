/**
 * analytics-report agent implementation.
 *
 * Produces an evidence-grounded product analytics report from the task's input
 * files by calling the real example-service `handleChat()`.
 */

import { handleChat, type ChatRequest } from "../../../../../app/lib/agent/service.ts";

const REPORT_SYSTEM_PROMPT =
  "You are a product analytics agent with access to tools. " +
  "Always use list_files first, then read_file for the exact paths shown. " +
  "Never answer from assumptions or memory. " +
  "For every derived metric (growth, retention), call the compute tool with the " +
  "exact arithmetic and state the computed result. Do not do arithmetic in your head. " +
  "You must call compute separately for active-user growth, 30-day retention, and " +
  "revenue growth before writing the final report. Do not stop after reading the file. " +
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
    maxSteps: 6,
  });

  return {
    response: result.response,
    tool_calls: result.tool_calls,
    usage: result.usage,
  };
}
