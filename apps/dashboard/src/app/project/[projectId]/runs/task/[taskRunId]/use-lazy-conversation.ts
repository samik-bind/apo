import { useEffect, useRef, useState } from "react";
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
 * results are cached for the current project and trace, while interrupted or
 * failed requests retry the next time the tab opens.
 */
export function useLazyConversation(
  traceRunId: string | null,
  projectId: string | null | undefined,
  enabled: boolean,
): ConversationState {
  const [state, setState] = useState<ConversationState>({ status: "idle" });
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!traceRunId) {
      // A running task may receive its trace ID on a later page refresh.
      loadedKeyRef.current = null;
      setState({ status: "ready", messages: [] });
      return;
    }

    const requestKey = `${projectId ?? ""}:${traceRunId}`;
    if (loadedKeyRef.current === requestKey) return;

    const controller = new AbortController();
    setState({ status: "loading" });
    getTraceDetail(traceRunId, projectId ?? undefined, controller.signal)
      .then((trace) => {
        if (controller.signal.aborted) return;
        loadedKeyRef.current = requestKey;
        setState({
          status: "ready",
          messages: deriveConversationFromTrace(trace).messages,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Failed to load transcript",
        });
      });

    return () => controller.abort();
  }, [enabled, traceRunId, projectId]);

  return state;
}
