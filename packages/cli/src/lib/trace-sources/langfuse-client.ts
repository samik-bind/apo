import type { JsonValue, LangfuseObservation } from "./langfuse-otlp.ts";

export interface LangfuseConnectorConfig {
  host: string;
  publicKey: string;
  secretKey: string;
  maxObservations: number;
}

export interface LangfuseTraceGraph {
  sourceHost: string;
  sourceTraceId: string;
  observations: readonly LangfuseObservation[];
}

export class LangfuseEmptyTraceError extends Error {
  readonly sourceTraceId: string;
  constructor(sourceTraceId: string, message: string) {
    super(message);
    this.name = "LangfuseEmptyTraceError";
    this.sourceTraceId = sourceTraceId;
  }
}

export interface LangfusePollTiming {
  initialIntervalMs: number;
  maxIntervalMs: number;
  backoffFactor: number;
}

export interface LangfusePollOptions extends LangfusePollTiming {
  totalDeadlineMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_LANGFUSE_POLL_TIMING: LangfusePollTiming = {
  initialIntervalMs: 2_000,
  maxIntervalMs: 15_000,
  backoffFactor: 1.5,
};

export const DEFAULT_MAX_OBSERVATIONS = 10_000;
const MIN_MAX_OBSERVATIONS = 1;
const MAX_MAX_OBSERVATIONS = 50_000;
const PAGE_LIMIT = 1000;
const PAGE_TIMEOUT_MS = 15_000;
const DETAIL_TIMEOUT_MS = 15_000;
// Per-id detail requests run concurrently but capped — N+1 requests against
// Langfuse, bounded by --max-observations and this pool size.
const DETAIL_CONCURRENCY = 6;
const FIELD_GROUPS = [
  "core",
  "basic",
  "time",
  "io",
  "metadata",
  "model",
  "usage",
  "metrics",
  "trace_context",
].join(",");
const DEFAULT_HOST = "https://cloud.langfuse.com";

type ResolveOptions = {
  hostFlag?: string;
  maxObservationsFlag?: string;
};

export function resolveConnectorConfig(options: ResolveOptions = {}): LangfuseConnectorConfig {
  const publicKey = (process.env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const secretKey = (process.env.LANGFUSE_SECRET_KEY ?? "").trim();

  // Surface missing var names without echoing any value the user supplied.
  if (!publicKey && !secretKey) {
    throw new Error(
      "Missing required environment variables: LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY",
    );
  }
  if (!publicKey) {
    throw new Error("Missing required environment variable: LANGFUSE_PUBLIC_KEY");
  }
  if (!secretKey) {
    throw new Error("Missing required environment variable: LANGFUSE_SECRET_KEY");
  }

  const hostInput = (options.hostFlag || process.env.LANGFUSE_HOST || DEFAULT_HOST).trim();
  const host = normalizeHost(hostInput);
  const maxObservations = resolveMaxObservations(options.maxObservationsFlag);

  return { host, publicKey, secretKey, maxObservations };
}

export async function fetchLangfuseTrace(
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
): Promise<LangfuseTraceGraph> {
  const rows: LangfuseObservation[] = [];
  let cursor: string | null = null;

  do {
    const page = await fetchObservationPage(sourceTraceId, cursor, config);
    for (const row of page.data) {
      if (rows.length >= config.maxObservations) {
        throw new Error(
          `Langfuse trace ${sourceTraceId} exceeded --max-observations ceiling (${config.maxObservations}); aborting before any apo write`,
        );
      }
      rows.push(validateObservation(row, sourceTraceId));
    }
    cursor = page.meta.cursor ?? null;
  } while (cursor !== null);

  if (rows.length === 0) {
    throw new LangfuseEmptyTraceError(
      sourceTraceId,
      `Langfuse returned no observations for source trace ${sourceTraceId}`,
    );
  }
  if (rows.length > config.maxObservations) {
    throw new Error(
      `Langfuse trace ${sourceTraceId} exceeded --max-observations ceiling (${config.maxObservations}); aborting before any apo write`,
    );
  }

  // The v2 LIST endpoint returns only summary fields (id/type/timing/usage).
  // Content-bearing fields (name/input/output/metadata/model) live exclusively
  // on the per-id detail endpoint — hydrate each observation there before
  // handing the graph to the converter, otherwise imports arrive empty (issue #25).
  const observations = await hydrateObservations(rows, config);

  return {
    sourceHost: config.host,
    sourceTraceId,
    observations,
  };
}

export async function pollLangfuseTrace(
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
  options: LangfusePollOptions,
): Promise<LangfuseTraceGraph> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + options.totalDeadlineMs;
  let interval = options.initialIntervalMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      return await fetchLangfuseTrace(sourceTraceId, config);
    } catch (error) {
      if (!(error instanceof LangfuseEmptyTraceError)) throw error;
    }

    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new LangfuseEmptyTraceError(
        sourceTraceId,
        `Langfuse returned no observations for source trace ${sourceTraceId}` +
          ` after waiting ${Math.round(options.totalDeadlineMs / 1000)}s` +
          ` across ${attempts} attempt${attempts === 1 ? "" : "s"}.` +
          ` Ingestion may still be pending; safe to retry.`,
      );
    }
    await sleep(Math.min(interval, options.maxIntervalMs, remaining));
    interval = Math.min(interval * options.backoffFactor, options.maxIntervalMs);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LangfuseObservationPage = {
  data: LangfuseObservation[];
  meta: { cursor?: string | null };
};

async function fetchObservationPage(
  sourceTraceId: string,
  cursor: string | null,
  config: LangfuseConnectorConfig,
): Promise<LangfuseObservationPage> {
  const url = buildObservationsUrl(config.host, sourceTraceId, cursor);
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Langfuse request timed out after ${PAGE_TIMEOUT_MS / 1000}s for source trace ${sourceTraceId}`,
      );
    }
    throw new Error(
      `Cannot reach Langfuse at ${config.host} for source trace ${sourceTraceId}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Langfuse authentication failed (${response.status}): credentials rejected for source trace ${sourceTraceId}. Check LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY and that the keys belong to the right Langfuse project.`,
    );
  }
  if (response.status === 404) {
    throw new Error(
      `Langfuse returned 404 for source trace ${sourceTraceId}`,
    );
  }
  if (response.status === 429) {
    throw new Error(
      `Langfuse rate-limited the request for source trace ${sourceTraceId}; safe to retry after backoff`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Langfuse request failed (${response.status}) for source trace ${sourceTraceId} at ${config.host}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(
      `Langfuse returned a non-JSON response for source trace ${sourceTraceId}`,
    );
  }
  return validateObservationPage(parsed, sourceTraceId);
}

function buildObservationsUrl(
  host: string,
  sourceTraceId: string,
  cursor: string | null,
): URL {
  const url = new URL("/api/public/v2/observations", host);
  url.searchParams.set("traceId", sourceTraceId);
  url.searchParams.set("fields", FIELD_GROUPS);
  // parseIoAsJson is intentionally NOT sent: Langfuse Cloud removed it from
  // the v2 observations endpoint and now 400s on it. I/O always comes back as
  // raw JSON strings and is parsed client-side in coerceIoField().
  url.searchParams.set("limit", String(PAGE_LIMIT));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url;
}

function validateObservationPage(
  parsed: unknown,
  sourceTraceId: string,
): LangfuseObservationPage {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Langfuse response for source trace ${sourceTraceId} was not an object`,
    );
  }
  const obj = parsed as { data?: unknown; meta?: unknown };
  if (!Array.isArray(obj.data)) {
    throw new Error(
      `Langfuse response for source trace ${sourceTraceId} is missing a 'data' array`,
    );
  }
  const meta = (obj.meta ?? {}) as { cursor?: string | null };
  return { data: obj.data as LangfuseObservation[], meta };
}

function validateObservation(
  row: unknown,
  sourceTraceId: string,
): LangfuseObservation {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error(
      `Langfuse returned a non-object observation row for source trace ${sourceTraceId}`,
    );
  }
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.traceId !== "string" || typeof r.type !== "string") {
    throw new Error(
      `Langfuse observation for source trace ${sourceTraceId} is missing core fields (id/traceId/type)`,
    );
  }
  if (r.traceId !== sourceTraceId) {
    throw new Error(
      `Langfuse observation ${r.id} traceId (${r.traceId}) does not match requested source trace ${sourceTraceId}`,
    );
  }
  return {
    ...(row as object),
    input: coerceIoField(r.input),
    output: coerceIoField(r.output),
    metadata: coerceIoField(r.metadata),
  } as LangfuseObservation;
}

// --- Detail hydration -------------------------------------------------------
// The v2 LIST endpoint returns only summary fields; name/input/output/metadata/
// model only appear on GET /api/public/observations/{id}. We fetch the detail
// for every discovered observation (bounded concurrency) and merge it over the
// list row so content is never silently lost (issue #25).

async function hydrateObservations(
  rows: readonly LangfuseObservation[],
  config: LangfuseConnectorConfig,
): Promise<LangfuseObservation[]> {
  const details = await mapWithConcurrency(rows, DETAIL_CONCURRENCY, (row) =>
    fetchObservationDetail(row.id, row.traceId, config),
  );
  return rows.map((row, i) => mergeObservation(row, details[i]!));
}

async function fetchObservationDetail(
  observationId: string,
  sourceTraceId: string,
  config: LangfuseConnectorConfig,
): Promise<Record<string, unknown>> {
  const url = new URL(
    `/api/public/observations/${encodeURIComponent(observationId)}`,
    config.host,
  );
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`, "utf8").toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Langfuse detail request timed out after ${DETAIL_TIMEOUT_MS / 1000}s for observation ${observationId} (source trace ${sourceTraceId})`,
      );
    }
    throw new Error(
      `Cannot reach Langfuse detail endpoint for observation ${observationId} (source trace ${sourceTraceId})`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    throw new Error(
      `Langfuse returned 404 for observation ${observationId} (source trace ${sourceTraceId}); it may have been deleted between discovery and hydration`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Langfuse authentication failed (${response.status}) fetching detail for observation ${observationId}`,
    );
  }
  if (response.status === 429) {
    throw new Error(
      `Langfuse rate-limited the detail request for observation ${observationId}; safe to retry after backoff`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Langfuse detail request failed (${response.status}) for observation ${observationId} at ${config.host}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(
      `Langfuse detail response for observation ${observationId} was not JSON`,
    );
  }
  return validateDetailObject(parsed, observationId, sourceTraceId);
}

function validateDetailObject(
  parsed: unknown,
  observationId: string,
  sourceTraceId: string,
): Record<string, unknown> {
  // Some Langfuse builds wrap single resources in { data: {...} }; unwrap if so.
  const unwrapped =
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "data" in parsed &&
    (parsed as { data?: unknown }).data !== null &&
    typeof (parsed as { data?: unknown }).data === "object"
      ? (parsed as { data: Record<string, unknown> }).data
      : parsed;

  if (unwrapped === null || typeof unwrapped !== "object" || Array.isArray(unwrapped)) {
    throw new Error(
      `Langfuse detail response for observation ${observationId} was not an object`,
    );
  }
  const obj = unwrapped as Record<string, unknown>;
  if (obj.id !== observationId) {
    throw new Error(
      `Langfuse detail response id (${String(obj.id)}) does not match requested observation ${observationId}`,
    );
  }
  // traceId is present on the detail payload; verify it lines up so a stale
  // or cross-trace detail never contaminates the graph.
  if (typeof obj.traceId === "string" && obj.traceId !== sourceTraceId) {
    throw new Error(
      `Langfuse detail for observation ${observationId} traceId (${obj.traceId}) does not match source trace ${sourceTraceId}`,
    );
  }
  return obj;
}

function mergeObservation(
  listRow: LangfuseObservation,
  detail: Record<string, unknown>,
): LangfuseObservation {
  // The detail endpoint is authoritative for content; spread it over the list
  // row (which still provides the structural backbone: parent/timing/usage).
  const merged = {
    ...listRow,
    ...detail,
    input: coerceIoField(detail.input),
    output: coerceIoField(detail.output),
    metadata: coerceIoField(detail.metadata),
    providedModelName: resolveModelName(detail, listRow),
  } as LangfuseObservation;
  return merged;
}

function resolveModelName(
  detail: Record<string, unknown>,
  listRow: LangfuseObservation,
): string | null | undefined {
  // The public REST detail endpoint names the field `model`; some self-hosted
  // builds mirror the OTLP `providedModelName`. Prefer whichever is present.
  if (typeof detail.providedModelName === "string") return detail.providedModelName;
  if (typeof detail.model === "string") return detail.model;
  return listRow.providedModelName ?? null;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  async function run(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!, index);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) {
    workers.push(run());
  }
  await Promise.all(workers);
  return results;
}

// Both the v2 LIST rows and the per-id DETAIL payload may carry input/output/
// metadata either as raw JSON strings (Langfuse Cloud) or as already-parsed
// objects (self-hosted/older builds). Parse them back into structured JsonValue
// objects so the downstream converter can map gen_ai.input.messages etc. without
// special-casing strings. This runs against the DETAIL response today, since the
// list no longer returns content fields (issue #25).
//
//   undefined  -> undefined  (absent field)
//   null       -> null       (explicit JSON null)
//   "<json>"   -> parsed JSON value (falls back to the raw string on bad JSON)
//   <object>   -> unchanged  (self-hosted/older Langfuse may still send parsed)
function coerceIoField(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value as JsonValue;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    // Not valid JSON — preserve the raw string rather than dropping data.
    return value;
  }
}

function normalizeHost(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid LANGFUSE_HOST URL: ${redact(input)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `LANGFUSE_HOST must be http(s); got scheme ${url.protocol.replace(":", "")}`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      "LANGFUSE_HOST must not contain embedded credentials",
    );
  }
  // Origin-only: drop path/query/fragment. Lowercase scheme + host.
  return `${url.protocol}//${url.host}`;
}

function resolveMaxObservations(flag: string | undefined): number {
  if (!flag) return DEFAULT_MAX_OBSERVATIONS;
  const n = Number(flag);
  if (!Number.isInteger(n) || n < MIN_MAX_OBSERVATIONS || n > MAX_MAX_OBSERVATIONS) {
    throw new Error(
      `--max-observations must be an integer in ${MIN_MAX_OBSERVATIONS}..${MAX_MAX_OBSERVATIONS}; got ${redact(flag)}`,
    );
  }
  return n;
}

function redact(value: string): string {
  // Never echo back a value that might be a secret in disguise.
  if (value.length > 32) return value.slice(0, 8) + "...(redacted)";
  return value.replace(/[\w-]{8,}/g, "(redacted)");
}

export type { JsonValue };
