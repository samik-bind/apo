/**
 * Detection for message text that is really a JSON payload.
 *
 * A model answering with structured output puts the JSON in an ordinary text
 * message — `{"gist":"…","notes":[…]}` arrives as `content`, with nothing on
 * the wire marking it as JSON (the OTel gen_ai semconv carries message content
 * as a string whatever its shape). Rendered as markdown it collapses into one
 * unreadable paragraph.
 *
 * The single home for that decision, so the surfaces that render these
 * messages agree on what counts — each still presents it in its own idiom
 * (a compact code block in a trace message bubble, `ExpandableJson` where
 * there is room for a tree).
 */

/**
 * The JSON payload a message's text carries, or `null` when it isn't one.
 *
 * Deliberately narrow: only an object or array counts. `42`, `true`, `null`
 * and `"quoted"` are all valid JSON documents that read as prose, and treating
 * them as payloads would be a regression.
 *
 * Trimmed first because `String.trim` strips more than JSON's own whitespace
 * — a BOM, a non-breaking space — and a payload carrying one of those is
 * still a payload.
 */
export function parseJsonPayload(text: string): unknown | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  return parsed;
}

/** {@link parseJsonPayload}, indented for display, or `null`. */
export function formatJsonMessageText(text: string): string | null {
  const payload = parseJsonPayload(text);
  if (payload === null) return null;
  return JSON.stringify(payload, null, 2);
}
