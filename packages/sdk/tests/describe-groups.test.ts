import { describe as suite, it, expect } from "vitest";
import {
  defineCheck,
  describe,
  resetFlowChecks,
  runTraceChecks,
} from "../src/agent-task/checks/flow-runner.ts";
import { aggregateResult } from "../src/agent-task/run/aggregate.ts";
import type { TraceProjectionSnapshot } from "../src/agent-task/trace-projection/types.ts";

// Minimal message-only snapshot — no tool calls, so tool assertions fail.
const emptySnapshot: TraceProjectionSnapshot = {
  schemaVersion: 1,
  projectionVersion: 1,
  source: "canonical",
  trace: {
    traceId: "test",
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    complete: true,
  },
  capabilities: {
    messages: "available",
    tools: "available",
    errors: "available",
    timing: "available",
    skills: "available",
    subagents: "available",
  },
  observations: [],
};

async function runChecks() {
  return runTraceChecks({ snapshot: emptySnapshot, deliverables: {} });
}

suite("describe() test groups", () => {
  it("stamps group_id + group_name on checks inside describe", async () => {
    resetFlowChecks();
    describe("rules", "Rules — each comment becomes a rule", () => {
      defineCheck("R-0", () => {});
      defineCheck("R-1", () => {});
    });

    const results = await runChecks();
    expect(results).toHaveLength(2);
    expect(results[0]!.group_id).toBe("rules");
    expect(results[0]!.group_name).toBe("Rules — each comment becomes a rule");
    expect(results[1]!.group_id).toBe("rules");
    expect(results[1]!.group_name).toBe("Rules — each comment becomes a rule");
  });

  it("leaves group_id off checks declared outside describe", async () => {
    resetFlowChecks();
    defineCheck("bare", () => {});

    const [result] = await runChecks();
    expect(result.group_id).toBeUndefined();
    expect(result.group_name).toBeUndefined();
  });

  it("tags each sibling describe's checks with its own group", async () => {
    resetFlowChecks();
    describe("rules", () => {
      defineCheck("R-0", () => {});
    });
    describe("safety", "Safety checks", () => {
      defineCheck("no-pii", () => {});
      defineCheck("no-secrets", () => {});
    });

    const results = await runChecks();
    expect(results).toHaveLength(3);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["R-0"]!.group_id).toBe("rules");
    expect(byId["no-pii"]!.group_id).toBe("safety");
    expect(byId["no-pii"]!.group_name).toBe("Safety checks");
    expect(byId["no-secrets"]!.group_id).toBe("safety");
  });

  it("throws when describe is nested (single-level only)", () => {
    resetFlowChecks();
    expect(() =>
      describe("outer", () => {
        describe("inner", () => {
          defineCheck("x", () => {});
        });
      }),
    ).toThrow(/cannot nest/i);
  });

  it("throws on duplicate describe id", () => {
    resetFlowChecks();
    describe("rules", () => {
      defineCheck("R-0", () => {});
    });
    expect(() =>
      describe("rules", () => {
        defineCheck("R-1", () => {});
      }),
    ).toThrow(/Duplicate describe id 'rules'/);
  });

  it("uses the id as the display name when no name is given", async () => {
    resetFlowChecks();
    describe("rules", () => {
      defineCheck("R-0", () => {});
    });

    const [result] = await runChecks();
    expect(result.group_name).toBe("rules");
  });

  it("transports nothing for an empty describe", async () => {
    resetFlowChecks();
    describe("empty", () => {});
    defineCheck("bare", () => {});

    const results = await runChecks();
    expect(results).toHaveLength(1);
    expect(results[0]!.group_id).toBeUndefined();
  });

  it("does not change the task verdict (group is organizational only)", () => {
    resetFlowChecks();
    describe("rules", () => {
      defineCheck("passes", (t) => {
        t.usedNoTools();
      });
      defineCheck("fails", (t) => {
        t.calledTool("read_file");
      });
    });

    // aggregateResult runs over the flat result array; a group with one
    // failing check makes the task fail — same as without grouping.
    return runChecks().then((results) => {
      const agg = aggregateResult(results);
      expect(agg.pass).toBe(false);
      expect(agg.checks).toHaveLength(2);
    });
  });

  it("preserves registration order within a group and across siblings", async () => {
    resetFlowChecks();
    defineCheck("first-bare", () => {});
    describe("g1", () => {
      defineCheck("g1-a", () => {});
      defineCheck("g1-b", () => {});
    });
    describe("g2", () => {
      defineCheck("g2-a", () => {});
    });

    const results = await runChecks();
    expect(results.map((r) => r.id)).toEqual([
      "first-bare",
      "g1-a",
      "g1-b",
      "g2-a",
    ]);
  });
});
