import { task, defineAdapter, equals, turn } from "@apo/sdk/agent-task";

// Minimal stub adapter — returns canned deliverables, no real LLM. Used only
// to exercise describe() end-to-end through runTaskDir.
const stubAdapter = defineAdapter({
  name: "stub",
  deliverables: { answer: null },
  async startSession() {
    return {
      async sendUserTurn() {
        return { response: "stubbed" };
      },
    };
  },
  async collectDeliverables() {
    return { answer: "42" };
  },
});

const { test, describe } = task("verify-describe", {
  adapter: stubAdapter,
  deliverables: ["answer"],
});

turn(async () => "What is the answer?");

describe("rules", "Rules — generated family", () => {
  test("rule-passes", (t, { deliverables }) => {
    t.check(deliverables.answer, equals("42"));
  });
  test("rule-fails", (t, { deliverables }) => {
    t.check(deliverables.answer, equals("wrong"));
  });
});

describe("safety", () => {
  test("safe", (t, { deliverables }) => {
    t.check(deliverables.answer, equals("42"));
  });
});

test("bare-check", (t, { deliverables }) => {
  t.check(deliverables.answer, equals("42"));
});
