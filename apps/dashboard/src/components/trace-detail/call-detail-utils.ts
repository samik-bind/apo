// Pure formatting/derivation helpers shared by the call-detail views
// (CallDetailView, CallDetailHeader, CallPreviewTab, CallMetadataTab) and the
// trace-level header in TraceDetailView. Extracted verbatim from
// TraceDetailView.tsx.

import { getEventType } from "./trace-utils";

const shortDateTimeFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

export function formatDate(v: string | null) {
  if (!v) return "—";
  return shortDateTimeFormatter.format(new Date(v));
}

export function formatEventLabel(t: string) {
  return t === "tool_use" ? "Tool Call" : t.split("_").map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

export function getModelShort(model: string) {
  const s = model.split("/").at(-1) ?? model;
  return s.length > 18 ? `${s.slice(0, 18)}...` : s;
}

export function buildTracePreviewData(data: any, metadata?: Record<string, unknown> | null) {
  if (!data || typeof data !== "object" || !metadata || typeof metadata !== "object") return data;
  const eventType = typeof metadata.eventType === "string" ? metadata.eventType : undefined;
  if (!eventType) return data;
  return { ...data, type: eventType ?? data.type, metadata };
}

export function getObservationType(call: any) {
  const eventType = getEventType(call);
  if (call.tool_name || eventType === "tool_use") {
    return "tool";
  }
  if (call.model && call.model !== "unknown") {
    return "generation";
  }
  return call.call_type || "span";
}

export function formatMetaParts(parts: Array<string | null>) {
  return parts.filter(Boolean) as string[];
}

export function extractOutputText(output: any): string | null {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return null;
  if (typeof output.text === "string") return output.text;
  if (typeof output.content === "string") return output.content;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return null;
  }
}

export function isChatMlInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const obj = input as Record<string, unknown>;
  if (Array.isArray(obj.messages) && obj.messages.length > 0) return true;
  // Anthropic-style: { prompt: "..." } is a single user message
  if (typeof obj.prompt === "string") return true;
  return false;
}

export function formatParamValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  }
  const str = String(value);
  return str.length > 20 ? `${str.slice(0, 20)}...` : str;
}

const MODEL_PARAM_KEYS = [
  "temperature", "max_tokens", "top_p", "frequency_penalty",
  "presence_penalty", "stop", "response_format", "seed",
];

export function extractModelParams(call: any): Record<string, unknown> | null {
  const meta = call.metadata ?? call.meta;
  if (!meta || typeof meta !== "object") return null;

  const params: Record<string, unknown> = {};
  for (const key of MODEL_PARAM_KEYS) {
    if (meta[key] !== undefined) params[key] = meta[key];
    else if (meta.params?.[key] !== undefined) params[key] = meta.params[key];
    else if (meta.modelParams?.[key] !== undefined) params[key] = meta.modelParams[key];
  }

  return Object.keys(params).length > 0 ? params : null;
}

export function getAncestorPath(call: any, allCalls: any[]): any[] {
  const byId = new Map(allCalls.map((c: any) => [c.id, c]));
  const path: any[] = [call];
  let current = call;
  while (current.parent_call_id) {
    const parent = byId.get(current.parent_call_id);
    if (!parent) break;
    path.unshift(parent);
    current = parent;
  }
  return path;
}
