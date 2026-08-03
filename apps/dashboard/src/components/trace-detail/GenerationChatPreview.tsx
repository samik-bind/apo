"use client";

import { useMemo } from "react";
import { ChatMessagePreview } from "./ChatMessagePreview";

/**
 * Renders a generation's full prompt plus its response as ONE conversation —
 * the Langfuse combined-chat model (combineInputOutputMessages), instead of
 * two separate Input/Output panels.
 *
 * The model's input is the accumulated prompt (system + history + new turn);
 * its output is appended as a final assistant message. apo's output shapes are
 * synthesized into that assistant message:
 *   - { text }                 -> assistant message with that text
 *   - { toolCalls: [...] }     -> assistant message with OpenAI-style tool_calls
 *   - { messages: [...] }      -> those messages verbatim (already assistant-shaped)
 *
 * ChatMessagePreview handles the collapse (first/last window) and tool-call
 * rendering. Falls back to null when there's nothing combinable, so the caller
 * can render the legacy split panels instead.
 */
export function GenerationChatPreview({
  input,
  output,
}: {
  input: unknown;
  output: unknown;
}) {
  const combined = useMemo(
    () => combineGenerationMessages(input, output),
    [input, output],
  );

  if (combined.length === 0) return null;
  return <ChatMessagePreview data={{ messages: combined }} preview="history" />;
}

type ChatMessage = {
  role: string;
  content: string | unknown[];
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name: string; arguments: string };
  }>;
};

function combineGenerationMessages(input: unknown, output: unknown): ChatMessage[] {
  const inputMessages = parseInputMessages(input);
  const outputMessages = synthesizeOutputMessages(output);
  return [...inputMessages, ...outputMessages];
}

function parseInputMessages(input: unknown): ChatMessage[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const msgs = obj.messages;
  return Array.isArray(msgs) ? (msgs.filter((m) => m && typeof m === "object") as ChatMessage[]) : [];
}

function synthesizeOutputMessages(output: unknown): ChatMessage[] {
  if (!output || typeof output !== "object") return [];
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
