/**
 * Pure helpers for {@link GenerationChatPreview}: combine a generation's full
 * prompt plus its response into ONE conversation — the Langfuse combined-chat
 * model (combineInputOutputMessages) — instead of two separate Input/Output
 * panels.
 *
 * The model's input is the accumulated prompt (system + history + new turn);
 * its output is appended as a final assistant message. apo's output shapes are
 * synthesized into that assistant message:
 *   - { text }                 -> assistant message with that text
 *   - { toolCalls: [...] }     -> assistant message with OpenAI-style tool_calls
 *   - { messages: [...] }      -> those messages verbatim (already assistant-shaped)
 *
 * Kept out of the component file so the shaping logic stays unit-testable
 * (the tests import these directly) and the component module exports only the
 * component.
 */

export type ChatMessage = {
  role: string;
  content: string | unknown[];
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name: string; arguments: string };
  }>;
};

export function combineGenerationMessages(input: unknown, output: unknown): ChatMessage[] {
  const inputMessages = parseInputMessages(input);
  const outputMessages = synthesizeOutputMessages(output);
  return [...inputMessages, ...outputMessages];
}

export function parseInputMessages(input: unknown): ChatMessage[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const msgs = obj.messages;
  if (Array.isArray(msgs)) {
    return msgs.filter((m) => m && typeof m === "object") as ChatMessage[];
  }
  // Anthropic-style: { prompt: "..." } → single user message
  if (typeof obj.prompt === "string") {
    return [{ role: "user", content: obj.prompt }];
  }
  return [];
}

export function synthesizeOutputMessages(output: unknown): ChatMessage[] {
  if (!output) return [];

  // Anthropic-style: bare array of content blocks (text, reasoning, tool_use)
  if (Array.isArray(output)) {
    const blocks = output as Array<Record<string, unknown>>;
    const toolCalls = blocks.flatMap((b) =>
      b?.type === "tool_use"
        ? [{
            id: typeof b.id === "string" ? b.id : undefined,
            type: "function" as const,
            function: {
              name: typeof b.name === "string" ? b.name : "tool",
              arguments: JSON.stringify(b.input ?? {}),
            },
          }]
        : [],
    );
    const contentParts = blocks.filter((b) => b?.type !== "tool_use");
    return [{
      role: "assistant",
      content: contentParts.length > 0 ? contentParts : "",
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    }];
  }

  if (typeof output !== "object") return [];
  const obj = output as Record<string, unknown>;

  // Output already carries messages (some SDKs) — pass through.
  if (Array.isArray(obj.messages)) {
    return obj.messages.filter((m) => m && typeof m === "object") as ChatMessage[];
  }

  // Tool-call round: { finishReason, toolCalls: [{ toolName, input, toolCallId }] }
  if (Array.isArray(obj.toolCalls) && obj.toolCalls.length > 0) {
    const toolCalls = obj.toolCalls.map((tc) => {
      const t = (tc ?? {}) as Record<string, unknown>;
      const args =
        typeof t.input === "string"
          ? t.input
          : t.input === undefined || t.input === null
            ? "{}"
            : JSON.stringify(t.input);
      return {
        id: typeof t.toolCallId === "string" ? t.toolCallId : undefined,
        type: "function",
        function: {
          name: typeof t.toolName === "string" ? t.toolName : "tool",
          arguments: args,
        },
      };
    });
    return [{ role: "assistant", content: "", tool_calls: toolCalls }];
  }

  // Text round: { text: "..." }
  if (typeof obj.text === "string" && obj.text.length > 0) {
    return [{ role: "assistant", content: obj.text }];
  }

  return [];
}
