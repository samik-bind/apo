import { describe, it, expect } from "vitest";
import {
  combineGenerationMessages,
  parseInputMessages,
  synthesizeOutputMessages,
} from "../GenerationChatPreview";

describe("synthesizeOutputMessages", () => {
  it("wraps a bare array of Anthropic content blocks as an assistant message", () => {
    const blocks = [
      { type: "text", text: "Here is the answer." },
      { type: "tool_use", id: "tu_1", name: "search", input: { q: "foo" } },
    ];
    const result = synthesizeOutputMessages(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("assistant");
    // text blocks stay as content
    const content = result[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    // tool_use blocks extracted to tool_calls (OpenAI shape)
    expect(result[0]!.tool_calls).toHaveLength(1);
    expect(result[0]!.tool_calls![0]!.function!.name).toBe("search");
    expect(result[0]!.tool_calls![0]!.function!.arguments).toBe('{"q":"foo"}');
  });

  it("handles Anthropic reasoning + text blocks (no tool_use)", () => {
    const blocks = [
      { type: "reasoning", text: "Let me think about this." },
      { type: "text", text: "The answer is 42." },
    ];
    const result = synthesizeOutputMessages(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("assistant");
    expect(Array.isArray(result[0]!.content)).toBe(true);
    expect(result[0]!.tool_calls).toBeUndefined();
  });

  it("still handles {text} shape (issue #63)", () => {
    const result = synthesizeOutputMessages({ text: "hello" });
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("assistant");
    expect(result[0]!.content).toBe("hello");
  });

  it("still handles {toolCalls} shape", () => {
    const result = synthesizeOutputMessages({
      finishReason: "tool-calls",
      toolCalls: [{ toolName: "list_files", input: "{}", toolCallId: "c1" }],
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.tool_calls).toHaveLength(1);
    expect(result[0]!.tool_calls![0]!.function!.name).toBe("list_files");
  });
});

describe("parseInputMessages", () => {
  it("accepts {prompt: string} as a single user message (Anthropic-style)", () => {
    const result = parseInputMessages({ prompt: "What are the pricing plans?" });
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toBe("What are the pricing plans?");
  });

  it("still accepts {messages: [...]} (ChatML)", () => {
    const result = parseInputMessages({
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("system");
    expect(result[1]!.role).toBe("user");
  });
});

describe("combineGenerationMessages", () => {
  it("combines {prompt} input with Anthropic-blocks output", () => {
    const combined = combineGenerationMessages(
      { prompt: "Review this code." },
      [{ type: "text", text: "Looks good." }],
    );
    // 1 user (from prompt) + 1 assistant (from blocks) = 2
    expect(combined).toHaveLength(2);
    expect(combined[0]!.role).toBe("user");
    expect(combined[1]!.role).toBe("assistant");
  });
});
