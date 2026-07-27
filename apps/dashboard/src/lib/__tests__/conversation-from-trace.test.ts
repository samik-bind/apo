import { describe, it, expect } from "vitest";

import { deriveConversationFromTrace } from "../conversation-from-trace";
import type { LoggedCall, TraceDetail } from "@/components/trace-detail/contexts";

function makeCall(overrides: Partial<LoggedCall> = {}): LoggedCall {
  return {
    id: "call-1",
    step_index: null,
    step_name: "generation",
    model: "claude-sonnet-4-6",
    created_at: "2026-07-27T10:00:00Z",
    task_id: "t",
    observation_type: "GENERATION",
    input: {},
    output: {},
    ...overrides,
  };
}

function makeTrace(calls: LoggedCall[]): TraceDetail {
  return {
    run: {
      id: "trace-1",
      project: "p",
      scopeKey: null,
      environment: "default",
      created_at: "2026-07-27T10:00:00Z",
      call_count: calls.length,
    },
    metrics: [],
    calls,
  };
}

describe("deriveConversationFromTrace", () => {
  describe("native SDK traces (messages arrays)", () => {
    it("reads the last generation's input+output messages", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          input: {
            messages: [
              { role: "system", content: "You are helpful." },
              { role: "user", content: "What is 2+2?" },
            ],
          },
          output: {
            messages: [{ role: "assistant", content: "It's 4." }],
          },
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      expect(result.messages.map((m) => `${m.role}:${m.content}`)).toEqual([
        "system:You are helpful.",
        "user:What is 2+2?",
        "assistant:It's 4.",
      ]);
    });
  });

  describe("imported traces with provider content blocks (issue #47)", () => {
    it("reconstructs conversation from content-block outputs when messages are absent", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          step_index: 0,
          input: "What plans do you offer?",
          output: [{ type: "text", text: "We offer Starter and Business plans." }],
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      expect(result.messages.length).toBeGreaterThan(0);
      const assistant = result.messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toContain("Starter and Business");
    });

    it("walks multiple generations in order, extracting user input + assistant output", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          step_index: 0,
          input: "What is the Starter price?",
          output: [{ type: "text", text: "Starter is €108/month." }],
        }),
        makeCall({
          id: "gen-2",
          step_index: 1,
          input: { tool_results: [{ tool_use_id: "t1", preview: "Pricing data loaded" }] },
          output: [{ type: "text", text: "Business is €600/month." }],
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      const contents = result.messages.map((m) => m.content);

      // Both assistant responses should appear
      expect(contents).toContain("Starter is €108/month.");
      expect(contents).toContain("Business is €600/month.");
      // The tool result should surface as context
      expect(result.messages.some((m) => m.content.includes("Pricing data loaded"))).toBe(true);
    });

    it("joins multiple text blocks in a single output into one message", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          step_index: 0,
          input: "Tell me about your plans",
          output: [
            { type: "reasoning", text: "The user wants pricing info." },
            { type: "text", text: "We have three plans available." },
          ],
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      const assistant = result.messages.find((m) => m.role === "assistant");
      expect(assistant?.content).toContain("three plans");
    });
  });

  describe("edge cases", () => {
    it("returns empty for a null trace", () => {
      expect(deriveConversationFromTrace(null).messages).toEqual([]);
    });

    it("returns empty when there are no calls", () => {
      expect(deriveConversationFromTrace(makeTrace([])).messages).toEqual([]);
    });

    it("returns empty when no calls have any extractable content", () => {
      const trace = makeTrace([
        makeCall({ id: "gen-1", input: {}, output: {} }),
      ]);
      expect(deriveConversationFromTrace(trace).messages).toEqual([]);
    });

    it("prefers messages arrays over raw content blocks when both exist", () => {
      const trace = makeTrace([
        makeCall({
          id: "gen-1",
          input: {
            messages: [
              { role: "user", content: "From messages array" },
            ],
          },
          output: [{ type: "text", text: "From content blocks" }],
        }),
      ]);

      const result = deriveConversationFromTrace(trace);
      // The messages-array path should win
      expect(result.messages.some((m) => m.content === "From messages array")).toBe(true);
      expect(result.messages.some((m) => m.content === "From content blocks")).toBe(false);
    });
  });
});
