"use client";

import { useMemo } from "react";
import { ChatMessagePreview } from "./ChatMessagePreview";
import { combineGenerationMessages } from "./generation-chat-preview-utils";

/**
 * Renders a generation's full prompt plus its response as ONE conversation —
 * the Langfuse combined-chat model (combineInputOutputMessages), instead of
 * two separate Input/Output panels.
 *
 * The combining/shaping logic lives in `generation-chat-preview-utils.ts`
 * (pure, unit-tested). ChatMessagePreview handles the collapse (first/last
 * window) and tool-call rendering. Falls back to null when there's nothing
 * combinable, so the caller can render the legacy split panels instead.
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
  // preview="last": show only the model's response (the final message) by
  // default — "just the generation" — with the full accumulated prompt behind
  // a "Show full prompt (N messages)" toggle. Avoids re-displaying the whole
  // conversation history in every generation node.
  return <ChatMessagePreview data={{ messages: combined }} preview="last" />;
}
