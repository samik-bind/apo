/**
 * TraceView — typed, capability-gated, derived access over a
 * {@link TraceProjectionSnapshot}. This is the read model the projection-first
 * assertion surface queries. It is the projection analogue of `FlowView`.
 *
 * The defining difference from `FlowView` is **capability honesty**: when the
 * snapshot declares a category of evidence `unavailable`, the derived numeric
 * facts (`durationMs`, `failedActions`, `turnCount`) return `undefined` rather
 * than zero — so an assertion like `t.maxDurationMs` can record an explicit
 * `unsupported` outcome instead of vacuously passing against a fabricated 0ms.
 *
 * `toolNamesInOrder` sorts by observation invocation time (`startedAt`) with a
 * deterministic span-ID tie-breaker — NOT array/completion order. This fixes
 * the drift where concurrent tools appeared in completion order.
 */

import type {
  EvidenceAvailability,
  ObservationStatus,
  TraceProjectionCapabilities,
  TraceProjectionMessage,
  TraceProjectionObservation,
  TraceProjectionSnapshot,
} from "./types.ts";

/** The span name `runTask` gives each Task Turn (one `sendUserTurn` call). */
export const TASK_TURN_SPAN_NAME = "task.turn";

/** A tool call derived from a `TOOL` observation. */
export interface TraceToolCall {
  spanId: string;
  name: string;
  input?: unknown;
  output?: unknown;
  status: ObservationStatus;
  startedAt?: string;
}

/** A skill load derived from a `SKILL` observation. */
export interface TraceSkillLoad {
  spanId: string;
  skill: string;
  startedAt?: string;
}

/** A subagent delegation derived from an `AGENT` observation. */
export interface TraceSubagentCall {
  spanId: string;
  agent: string;
  output?: unknown;
  status: ObservationStatus;
  startedAt?: string;
}

/** One Task Turn, derived from a `task.turn` observation. */
export interface TraceTurn {
  /** 1-based, in invocation order. */
  turnNumber: number;
  spanId: string;
  durationMs?: number;
  status: ObservationStatus;
}

export type TokenKind = "input" | "output" | "total";

/**
 * Token usage summed over a scope (the whole agent execution, or one turn).
 * When `unreported` is non-zero, `tokens` is only a lower bound.
 */
export interface TraceTokenTally {
  tokens: number;
  /** Observations that contributed a count. */
  reported: number;
  /**
   * LLM calls in scope whose count is unknown or untrustworthy: a GENERATION
   * that reported no usage for the dimension, or an errored call (a provider
   * error often drops the final usage event, so its count may be short).
   */
  unreported: number;
}

/** Sentinel that sorts before every real timestamp in string comparison. */
const TIMESTAMPED_MIN = "";

/**
 * Comparison key for deterministic ordering by invocation time then span ID.
 * Missing `startedAt` sorts AFTER every timestamped observation.
 */
function invocationOrderKey(obs: TraceProjectionObservation): [number, string, string] {
  const hasTs = obs.startedAt != null ? 0 : 1;
  return [hasTs, obs.startedAt ?? "", obs.spanId];
}

export class TraceView {
  readonly snapshot: TraceProjectionSnapshot;

  constructor(snapshot: TraceProjectionSnapshot) {
    this.snapshot = snapshot;
  }

  /** Evidence availability for a capability. */
  requireCapability(
    capability: keyof TraceProjectionCapabilities,
  ): EvidenceAvailability {
    // `usage` is optional on snapshots written before it existed.
    return this.snapshot.capabilities[capability] ?? "unavailable";
  }

  /** Whether a capability is reported as available (not partial/unavailable). */
  private isAvailable(capability: keyof TraceProjectionCapabilities): boolean {
    return this.requireCapability(capability) === "available";
  }

  /** All chat messages flattened across generation observations, in order. */
  get messages(): readonly TraceProjectionMessage[] {
    const out: TraceProjectionMessage[] = [];
    for (const obs of this.sortedObservations) {
      if (obs.messages) out.push(...obs.messages);
    }
    return out;
  }

  /** Tool calls derived from `TOOL` observations, in invocation order. */
  get toolCalls(): readonly TraceToolCall[] {
    return this.sortedObservations
      .filter((o): o is TraceProjectionObservation & { type: "TOOL" } => o.type === "TOOL")
      .map((o) => ({
        spanId: o.spanId,
        name: o.toolName ?? o.name,
        input: o.toolParameters ?? o.input,
        output: o.toolResult ?? o.output,
        status: o.status,
        startedAt: o.startedAt,
      }));
  }

  /** Tool names in invocation order with deterministic span-ID tie-breaking. */
  get toolNamesInOrder(): readonly string[] {
    return this.toolCalls.map((c) => c.name);
  }

  /** Skill loads derived from `SKILL` observations, in invocation order. */
  get skillLoads(): readonly TraceSkillLoad[] {
    return this.sortedObservations
      .filter((o): o is TraceProjectionObservation & { type: "SKILL" } => o.type === "SKILL")
      .map((o) => ({ spanId: o.spanId, skill: o.name, startedAt: o.startedAt }));
  }

  /** Subagent delegations derived from `AGENT` observations, in invocation order. */
  get subagentCalls(): readonly TraceSubagentCall[] {
    return this.sortedObservations
      .filter((o): o is TraceProjectionObservation & { type: "AGENT" } => o.type === "AGENT")
      .map((o) => ({
        spanId: o.spanId,
        agent: o.name,
        output: o.output,
        status: o.status,
        startedAt: o.startedAt,
      }));
  }

  /** Last assistant message content — the agent's "reply". Empty if none. */
  get reply(): string {
    const msgs = this.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === "assistant") return msgs[i]!.content;
    }
    return "";
  }

  /**
   * Number of completed assistant turns, or `undefined` when message evidence
   * is unavailable (capability honesty).
   */
  get turnCount(): number | undefined {
    if (!this.isAvailable("messages")) return undefined;
    return this.messages.filter((m) => m.role === "assistant").length;
  }

  /**
   * Number of tool/subagent observations that reported an error, or `undefined`
   * when error evidence is unavailable (capability honesty).
   */
  get failedActions(): number | undefined {
    if (!this.isAvailable("errors")) return undefined;
    return this.sortedObservations.filter(
      (o) => (o.type === "TOOL" || o.type === "AGENT") && o.status === "error",
    ).length;
  }

  /**
   * Total execution duration in milliseconds, or `undefined` when timing
   * evidence is unavailable (capability honesty). Uses trace-level
   * startedAt/endedAt when present.
   */
  get durationMs(): number | undefined {
    if (!this.isAvailable("timing")) return undefined;
    const { startedAt, endedAt } = this.snapshot.trace;
    if (startedAt != null && endedAt != null) {
      const ms = Date.parse(endedAt) - Date.parse(startedAt);
      return Number.isNaN(ms) ? undefined : Math.max(0, ms);
    }
    return undefined;
  }

  /**
   * Task Turns in invocation order, or `undefined` when timing evidence is
   * unavailable. Each is one `task.turn` span: the adapter's whole
   * `sendUserTurn` call for that turn.
   */
  get turns(): readonly TraceTurn[] | undefined {
    if (!this.isAvailable("timing")) return undefined;
    return this.turnSpans
      .map((o, i) => ({
        turnNumber: i + 1,
        spanId: o.spanId,
        ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
        status: o.status,
      }));
  }

  /**
   * Tokens the agent under test spent: usage on observations inside
   * `task.turn` spans (every turn, or only turn `turn`). Work outside the
   * turns — the evaluation phase's judges, adapter setup — is not the
   * agent's and is excluded. `undefined` when usage evidence is unavailable
   * or the requested turn does not exist.
   */
  tokens(kind: TokenKind, opts?: { turn?: number }): TraceTokenTally | undefined {
    if (!this.isAvailable("usage")) return undefined;
    const turnSpans = this.turnSpans;
    let roots: readonly TraceProjectionObservation[];
    if (opts?.turn !== undefined) {
      const one = turnSpans[opts.turn - 1];
      if (!one) return undefined;
      roots = [one];
    } else {
      roots = turnSpans;
    }
    const tally: TraceTokenTally = { tokens: 0, reported: 0, unreported: 0 };
    const children = this.childrenByParent;
    const isLlmCall = (o: TraceProjectionObservation): boolean =>
      o.type === "GENERATION" || o.usage != null;

    // Every observation below the roots, each visited once, parents first.
    const order: TraceProjectionObservation[] = [];
    const visited = new Set<string>(roots.map((r) => r.spanId));
    const stack = roots.flatMap((r) => children.get(r.spanId) ?? []);
    const scopeChildren = new Map<string, TraceProjectionObservation[]>();
    const topLevel: TraceProjectionObservation[] = [...stack];
    while (stack.length > 0) {
      const obs = stack.pop()!;
      if (visited.has(obs.spanId)) continue;
      visited.add(obs.spanId);
      order.push(obs);
      const kids = (children.get(obs.spanId) ?? []).filter((c) => !visited.has(c.spanId));
      scopeChildren.set(obs.spanId, kids);
      stack.push(...kids);
    }

    // Usage nests: an LLM call can carry the sum of its per-step calls
    // directly beneath it (Vercel's ai.generateText over its doGenerate
    // steps), and which of the two a producer records differs between the
    // local and canonical paths. So a node's own count covers its direct
    // LLM-call children — it counts the larger of the two, never both.
    // Anything reached through another span (a tool that runs a subagent)
    // is a separate call and adds.
    const effective = new Map<string, number | undefined>();
    for (let i = order.length - 1; i >= 0; i--) {
      const obs = order[i]!;
      const { count, complete } = tokenCount(obs, kind);
      if (count !== undefined) tally.reported += 1;
      if (isLlmCall(obs) && (!complete || obs.status === "error")) tally.unreported += 1;
      let steps: number | undefined;
      let separate: number | undefined;
      for (const child of scopeChildren.get(obs.spanId) ?? []) {
        const c = effective.get(child.spanId);
        if (c === undefined) continue;
        if (isLlmCall(child)) steps = (steps ?? 0) + c;
        else separate = (separate ?? 0) + c;
      }
      const own =
        count === undefined ? steps : steps === undefined ? count : Math.max(count, steps);
      effective.set(
        obs.spanId,
        own === undefined && separate === undefined ? undefined : (own ?? 0) + (separate ?? 0),
      );
    }
    for (const obs of topLevel) {
      if (effective.has(obs.spanId)) tally.tokens += effective.get(obs.spanId) ?? 0;
      effective.delete(obs.spanId);
    }
    return tally;
  }

  /**
   * The run's own Task Turns: `task.turn` observations with no `task.turn`
   * ancestor (a nested run or a user span of the same name inside a turn is
   * part of that turn, not a turn of its own). Turns run sequentially, so
   * invocation order is turn order.
   */
  private get turnSpans(): readonly TraceProjectionObservation[] {
    if (this._turnSpans !== undefined) return this._turnSpans;
    const byId = new Map(this.snapshot.observations.map((o) => [o.spanId, o]));
    const insideAnotherTurn = (obs: TraceProjectionObservation): boolean => {
      const visited = new Set<string>([obs.spanId]);
      let parentId = obs.parentSpanId;
      while (parentId !== undefined && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) return false;
        if (parent.name === TASK_TURN_SPAN_NAME) return true;
        parentId = parent.parentSpanId;
      }
      return false;
    };
    this._turnSpans = this.sortedObservations.filter(
      (o) => o.name === TASK_TURN_SPAN_NAME && !insideAnotherTurn(o),
    );
    return this._turnSpans;
  }
  private _turnSpans: readonly TraceProjectionObservation[] | undefined;

  private get childrenByParent(): ReadonlyMap<string, TraceProjectionObservation[]> {
    if (this._children !== undefined) return this._children;
    const children = new Map<string, TraceProjectionObservation[]>();
    for (const obs of this.snapshot.observations) {
      if (obs.parentSpanId == null) continue;
      const list = children.get(obs.parentSpanId);
      if (list) list.push(obs);
      else children.set(obs.parentSpanId, [obs]);
    }
    this._children = children;
    return children;
  }
  private _children: ReadonlyMap<string, TraceProjectionObservation[]> | undefined;

  /**
   * Observations sorted deterministically by invocation time then span ID.
   * Memoized per TraceView instance since the snapshot is immutable.
   */
  private get sortedObservations(): readonly TraceProjectionObservation[] {
    if (this._sorted !== undefined) return this._sorted;
    // Copy to a mutable array, then sort by invocation key: missing timestamps
    // (key prefix 1) sort after timestamped ones (prefix 0), then by span ID
    // for determinism.
    const sorted = [...this.snapshot.observations].sort((a, b) => {
      const ka = invocationOrderKey(a);
      const kb = invocationOrderKey(b);
      return (
        ka[0] - kb[0] ||
        ka[1].localeCompare(kb[1]) ||
        ka[2].localeCompare(kb[2])
      );
    });
    this._sorted = sorted;
    return sorted;
  }
  private _sorted: readonly TraceProjectionObservation[] | undefined;
}

/**
 * The observation's count for `kind`. `complete` is false when a dimension the
 * count needs was not reported — a total with only input known is a lower
 * bound, not a total.
 */
function tokenCount(
  obs: TraceProjectionObservation,
  kind: TokenKind,
): { count: number | undefined; complete: boolean } {
  // Canonical snapshots serialize unreported dimensions as null.
  const input = typeof obs.usage?.inputTokens === "number" ? obs.usage.inputTokens : undefined;
  const output = typeof obs.usage?.outputTokens === "number" ? obs.usage.outputTokens : undefined;
  if (kind === "input") return { count: input, complete: input !== undefined };
  if (kind === "output") return { count: output, complete: output !== undefined };
  if (input === undefined && output === undefined) return { count: undefined, complete: false };
  return {
    count: (input ?? 0) + (output ?? 0),
    complete: input !== undefined && output !== undefined,
  };
}

// Keep the timestamp sentinel referenced for clarity — documents that empty
// string is the "earliest" timestamp in lexicographic ordering.
void TIMESTAMPED_MIN;
