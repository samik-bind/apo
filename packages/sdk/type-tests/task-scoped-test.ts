import {
  defineAdapter,
  task,
  test as globalTest,
} from "../src/agent-task/public.ts";

declare const mode: "report" | "stats";

const broadAdapter = defineAdapter({
  name: "broad-adapter",
  deliverables: {
    report: null,
    stats: null,
    declaredOnly: null,
  },
  async startSession() {
    return {
      async sendUserTurn() {
        return { response: "ok" };
      },
    };
  },
  async collectDeliverables() {
    return mode === "report"
      ? { report: { title: "Summary" } }
      : { stats: { turnCount: 1 } };
  },
});

const scope = task("report-task", {
  adapter: broadAdapter,
  deliverables: ["report"],
});

scope.test("report-title", (_t, { deliverables }) => {
  deliverables.report.title.toUpperCase();

  // @ts-expect-error The task did not select the adapter's stats deliverable.
  void deliverables.stats;
});

// describe() groups checks but does not change deliverable typing: a test
// inside describe still sees the task-scoped deliverables.
scope.describe("rules", () => {
  scope.test("rule-0", (_t, { deliverables }) => {
    deliverables.report.title.toUpperCase();
    // @ts-expect-error stats was not selected by this task.
    void deliverables.stats;
  });
});

// @ts-expect-error A task scope exposes only test + describe registration.
void scope.judge;

task("invalid-task", {
  adapter: broadAdapter,
  // @ts-expect-error A definition alone is not enough; the adapter never returns it.
  deliverables: ["declaredOnly"],
});

globalTest<{ manual: string }>("global-test-remains-compatible", (_t, context) => {
  context.deliverables.manual.toUpperCase();
});
