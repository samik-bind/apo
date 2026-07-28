import { describe, it, expect } from "vitest";
import { getRunSummary } from "../TraceTree";
import type { TraceObservation } from "../contexts";

function makeCall(overrides: Partial<TraceObservation> & { id: string }): TraceObservation {
  return {
    step_index: 0,
    step_name: null,
    model: "unknown",
    created_at: "2026-01-01T00:00:00.000Z",
    latency_ms: null,
    cost: null,
    input: null,
    output: null,
    task_id: null,
    parent_call_id: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    ...overrides,
  } as TraceObservation;
}

describe("getRunSummary", () => {
  // Regression: the trace header rendered call.cost (micro-USD) as if it were
  // USD, so a $0.44 run showed as "$440892.0000".
  it("renders the aggregated cost as USD, not micro-USD", () => {
    const calls = [
      makeCall({ id: "1", cost: 208741 }),
      makeCall({ id: "2", cost: 19307 }),
      makeCall({ id: "3", cost: 212844 }),
    ];
    expect(getRunSummary(calls).cost).toBe("$0.4409");
  });

  it("keeps sub-cent totals readable", () => {
    expect(getRunSummary([makeCall({ id: "1", cost: 1_000 })]).cost).toBe("$0.001000");
  });

  it("omits cost when nothing was billed", () => {
    expect(getRunSummary([makeCall({ id: "1", cost: 0 })]).cost).toBeNull();
    expect(getRunSummary([makeCall({ id: "1" })]).cost).toBeNull();
  });
});
