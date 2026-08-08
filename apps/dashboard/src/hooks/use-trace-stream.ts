"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getBrowserBackendBaseUrl } from "@/lib/config";
import { toBrowserProxyUrl } from "@/lib/backend-fetch";
import type { LoggedCall } from "@/components/trace-detail";

interface TraceSSEData {
  id: string;
  parent_call_id?: string | null;
  created_at?: string;
  latency_ms?: number | null;
  model?: string;
  step_name?: string | null;
  step_index?: number | null;
  observation_type?: string;
  level?: string;
  cost?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  time_to_first_token_ms?: number | null;
  status_message?: string | null;
  tool_name?: string | null;
  end_time?: string | null;
  name?: string | null;
  status?: string;
}

function normalizeCall(data: TraceSSEData): Partial<LoggedCall> {
  return {
    id: data.id,
    parent_call_id: data.parent_call_id ?? null,
    created_at: data.created_at ?? new Date().toISOString(),
    latency_ms: data.latency_ms ?? null,
    model: data.model ?? "unknown",
    step_name: data.step_name ?? data.name ?? null,
    step_index: data.step_index ?? null,
    observation_type: data.observation_type ?? "GENERATION",
    level: data.level ?? "DEFAULT",
    cost: data.cost ?? null,
    prompt_tokens: data.prompt_tokens ?? null,
    completion_tokens: data.completion_tokens ?? null,
    total_tokens: data.total_tokens ?? null,
    time_to_first_token_ms: data.time_to_first_token_ms ?? null,
    status_message: data.status_message ?? null,
    tool_name: data.tool_name ?? null,
    end_time: data.end_time ?? null,
  };
}

export function useTraceStream(traceId: string | null) {
  const [calls, setCalls] = useState<LoggedCall[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [prevTraceId, setPrevTraceId] = useState(traceId);
  const esRef = useRef<EventSource | null>(null);
  const handlerRef = useRef<(e: MessageEvent) => void>(() => {});
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the stream has been deliberately closed (terminal event, unmount,
  // or traceId cleared). Suppresses the onerror-driven reconnect so a blip after
  // completion — or the close itself firing onerror — can't spin up reconnects.
  const closedByUsRef = useRef(false);
  // Reconnect attempt counter for exponential backoff with a hard cap. Reset to
  // 0 on every successful connect so a stable connection doesn't keep backing off.
  const attemptsRef = useRef(0);
  // Span events buffered between flushes. The backend replays every existing
  // span as an individual event on connect, and each setCalls commit cascades
  // into a full tree/gantt re-render — so committing per event freezes the UI
  // for seconds on large running traces. Buffer and flush on an interval
  // instead; the buffer preserves event order so the flush applies the exact
  // created/updated semantics a per-event reducer would.
  const pendingRef = useRef<
    Array<{ kind: "created" | "updated"; data: Partial<LoggedCall> }>
  >([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPending = useCallback(() => {
    flushTimerRef.current = null;
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    pendingRef.current = [];
    setCalls((prev) => {
      const next = [...prev];
      const indexById = new Map(next.map((c, i) => [c.id, i] as const));
      for (const { kind, data } of pending) {
        const id = data.id;
        if (!id) continue;
        const idx = indexById.get(id);
        if (kind === "created") {
          if (idx === undefined) {
            indexById.set(id, next.length);
            next.push(data as LoggedCall);
          }
        } else if (idx !== undefined) {
          next[idx] = { ...next[idx], ...data };
        }
      }
      return next;
    });
  }, []);

  // Reset stream state when traceId changes/clears, done during render via the
  // prev-prop comparison pattern rather than inside the connect effect.
  if (traceId !== prevTraceId) {
    setPrevTraceId(traceId);
    if (!traceId) {
      setCalls([]);
      setIsLive(false);
    }
  }

  const connect = useCallback((id: string) => {
    if (esRef.current) {
      esRef.current.close();
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    // A fresh connect clears the "deliberately closed" flag. Calls already
    // received are preserved across reconnects — only the traceId-change path
    // (in the render-phase block above) wipes them.
    closedByUsRef.current = false;

    setIsLive(true);

    const baseUrl = String(toBrowserProxyUrl(getBrowserBackendBaseUrl()));
    // Cleanup lives in the consuming useEffect (detachAndClose); scanner can't trace it.
    // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
    const es = new EventSource(`${baseUrl}/v1/traces/${id}/stream`);
    esRef.current = es;

    es.onopen = () => {
      // A connection that actually opened breaks the consecutive-failure
      // streak. Do not reset this in connect(): reconnect attempts that fail
      // before opening must keep increasing the backoff and reach the cap.
      attemptsRef.current = 0;
    };

    es.onerror = () => {
      es.close();
      esRef.current = null;
      setIsLive(false);
      // Terminal close (trace completed, unmount, traceId cleared) must not
      // reconnect. Otherwise back off exponentially (3s, 6s, 12s, 15s, 15s)
      // and give up after MAX_RECONNECT_ATTEMPTS so a persistently failing
      // endpoint can't hammer the backend forever.
      if (closedByUsRef.current) return;
      attemptsRef.current += 1;
      if (attemptsRef.current > MAX_RECONNECT_ATTEMPTS) return;
      const delay = Math.min(
        BASE_RECONNECT_MS * 2 ** (attemptsRef.current - 1),
        MAX_RECONNECT_MS,
      );
      reconnectTimerRef.current = setTimeout(() => connect(id), delay);
    };

    const handleEvent = (e: MessageEvent) => {
      try {
        const event = JSON.parse(e.data);
        const data: TraceSSEData = event.data || {};

        if (event.event_type === "trace:created") {
          return;
        }
        if (event.event_type === "trace:completed") {
          setIsLive(false);
          // Terminal event: land any buffered spans, then close the stream and
          // arm the "closed by us" flag so the onerror that close() may fire —
          // or any later blip — cannot reconnect a trace that is already
          // finished.
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
          }
          flushPending();
          closedByUsRef.current = true;
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = null;
          }
          if (esRef.current) {
            detachAndClose(esRef.current, handlerRef.current);
            esRef.current = null;
          }
          return;
        }

        if (
          event.event_type === "span:created" ||
          event.event_type === "span:updated"
        ) {
          pendingRef.current.push({
            kind: event.event_type === "span:created" ? "created" : "updated",
            data: normalizeCall(data),
          });
          if (!flushTimerRef.current) {
            flushTimerRef.current = setTimeout(flushPending, FLUSH_INTERVAL_MS);
          }
        }
      } catch {
        // ignore malformed events
      }
    };
    handlerRef.current = handleEvent;

    for (const type of TRACE_EVENT_TYPES) {
      es.addEventListener(type, handleEvent);
    }
  }, [flushPending]);

  useEffect(() => {
    if (!traceId) {
      if (esRef.current) {
        detachAndClose(esRef.current, handlerRef.current);
        esRef.current = null;
      }
      return;
    }

    attemptsRef.current = 0;
    connect(traceId);

    return () => {
      // Suppress any reconnect from an unmount-triggered close.
      closedByUsRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      pendingRef.current = [];
      if (esRef.current) {
        detachAndClose(esRef.current, handlerRef.current);
        esRef.current = null;
      }
    };
  }, [traceId, connect]);

  return { calls, isLive };
}

const TRACE_EVENT_TYPES = ["trace:created", "span:created", "span:updated", "trace:completed"];

/** Coalescing window (ms) for span events; one setCalls commit per window. */
const FLUSH_INTERVAL_MS = 250;

/** Base delay (ms) for the first reconnect attempt; doubles each attempt up to the cap. */
const BASE_RECONNECT_MS = 3000;
/** Upper bound (ms) on a single reconnect backoff delay. */
const MAX_RECONNECT_MS = 15000;
/** Give up reconnecting after this many consecutive failed attempts. */
const MAX_RECONNECT_ATTEMPTS = 5;

/** Remove every listener we attached, then close the EventSource. */
function detachAndClose(
  es: EventSource,
  handler: (e: MessageEvent) => void,
): void {
  for (const type of TRACE_EVENT_TYPES) {
    es.removeEventListener(type, handler);
  }
  es.close();
}
