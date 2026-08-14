import { useEffect, useState } from "react";
import {
  deriveConversationFromTrace,
  type ChatMessage,
} from "@/lib/conversation-from-trace";
import { getTraceDetail } from "@/lib/traces-api";

export type ConversationState =
  | { status: "idle" | "loading" }
  | { status: "ready"; messages: ChatMessage[] }
  | { status: "error"; message: string };

/**
 * Fetch the linked trace only while the transcript tab is open. Successful
 * results are cached per project+trace, while interrupted or failed requests
 * retry the next time the tab opens. The status itself is derived during
 * render from the request key, so a key change never shows the previous
 * trace's messages for a frame.
 */
export function useLazyConversation(
  traceRunId: string | null,
  projectId: string | null | undefined,
  enabled: boolean,
): ConversationState {
  const [loaded, setLoaded] = useState<Record<string, ChatMessage[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const requestKey =
    enabled && traceRunId !== null ? `${projectId ?? ""}:${traceRunId}` : null;

  useEffect(() => {
    if (requestKey === null || traceRunId === null || requestKey in loaded) return;
    const controller = new AbortController();
    getTraceDetail(traceRunId, projectId ?? undefined, controller.signal)
      .then((trace) => {
        if (controller.signal.aborted) return;
        setLoaded((prev) => ({
          ...prev,
          [requestKey]: deriveConversationFromTrace(trace).messages,
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setErrors((prev) => ({
          ...prev,
          [requestKey]:
            error instanceof Error ? error.message : "Failed to load transcript",
        }));
      });
    return () => controller.abort();
  }, [requestKey, loaded, traceRunId, projectId]);

  if (!enabled) return { status: "idle" };
  // A running task may receive its trace ID on a later page refresh; until
  // then the transcript is simply empty.
  if (requestKey === null) return { status: "ready", messages: [] };
  if (requestKey in errors) return { status: "error", message: errors[requestKey] };
  if (requestKey in loaded) return { status: "ready", messages: loaded[requestKey] };
  return { status: "loading" };
}
