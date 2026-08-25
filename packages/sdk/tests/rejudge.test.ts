/**
 * Issue #159: rejudgeTaskRun — replay Phase 2 of a completed Run against
 * its stored Deliverables without re-running the agent.
 *
 * The backend is stubbed via global fetch: run detail, deliverable bodies,
 * pinned definition source, and (409) trace projection. The eval source
 * served by the stub is materialized into a local task dir so relative
 * imports resolve exactly like a live run.
 */

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { rejudgeTaskRun, RejudgeError } from "../src/agent-task/run/rejudge";

const TMP_ROOT = join(import.meta.dirname, "__rejudge_test__");
const LOCAL_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";
const LOCAL_PUBLIC_IMPORT = "../../../src/agent-task/public";

const BACKEND = "http://backend.test";
const RUN_ID = "run_rejudge1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function adapterModule(): string {
  return `
import { defineAdapter } from "${LOCAL_ADAPTER_IMPORT}";

export const rejudgeAdapter = defineAdapter({
  name: "rejudge-adapter",
  deliverables: { report: null, memo: null },
  turn: async () => null,
  async startSession() {
    return { async sendUserTurn() { return { response: "ack" }; } };
  },
  async collectDeliverables() {
    return { report: { title: "old" } };
  },
});
`;
}

function evalModule(options?: { withJudge?: boolean }): string {
  return `
import { task, filePaths, includes, satisfies } from "${LOCAL_PUBLIC_IMPORT}";
import { rejudgeAdapter } from "./adapter.ts";

const { test: check } = task("rejudge-demo", {
  adapter: rejudgeAdapter,
  deliverables: ["report", "memo"],
});

check("report-title", (t, { deliverables }) => {
  t.check(
    (deliverables.report as { title: string }).title,
    satisfies((v: string) => v === "Summary", "title is Summary"),
  );
});

check("fixture-file", (t, { files }) => {
  t.check(filePaths(files), includes("spec.md"));
});
${
  options?.withJudge
    ? `
check("judged-quality", async (t, { deliverables }) => {
  await t.judge(
    (deliverables.report as { title: string }).title,
    "PASS if the title reads well.",
  );
});
`
    : ""
}
`;
}

function makeTaskDir(name: string, evalContent: string): string {
  const dir = join(TMP_ROOT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "files"), { recursive: true });
  writeFileSync(join(dir, "adapter.ts"), adapterModule());
  writeFileSync(join(dir, "rejudge-demo.eval.ts"), evalContent);
  writeFileSync(join(dir, "files", "spec.md"), "# Spec\n");
  return dir;
}

interface DeliverableItem {
  id: string;
  name: string;
  kind: "json" | "artifact";
  status: string;
  media_type?: string;
  display_filename?: string | null;
}

interface BackendStub {
  runStatus?: string;
  deliverables?: DeliverableItem[];
  revisionOverride?: string;
  noPinnedRevision?: boolean;
  judgeResponses?: Array<{ pass: boolean; reasoning: string }>;
}

function stubBackend(stub: BackendStub, evalContent: string): ReturnType<typeof vi.fn> {
  const items: DeliverableItem[] =
    stub.deliverables ??
    [
      { id: "dlv-report", name: "report", kind: "json", status: "ready" },
      { id: "dlv-memo", name: "memo", kind: "artifact", status: "ready", media_type: "text/plain", display_filename: "memo.txt" },
    ];
  const judgeResponses = stub.judgeResponses ?? [];
  let judgeCall = 0;

  const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url === `${BACKEND}/v1/agent-task-runs/${RUN_ID}`) {
      return jsonResponse({
        id: RUN_ID,
        task_id: "rejudge-demo",
        status: stub.runStatus ?? "passed",
        pass_result: true,
        deliverables_json: {},
        task_definition: stub.noPinnedRevision ? null : { id: "rev-pinned" },
        judgments_count: 0,
      });
    }
    if (url === `${BACKEND}/v1/agent-task-runs/${RUN_ID}/deliverables`) {
      return jsonResponse({ task_run_id: RUN_ID, items });
    }
    if (url.startsWith(`${BACKEND}/v1/agent-task-runs/${RUN_ID}/definition-source`)) {
      return jsonResponse({
        task_definition_revision_id: stub.revisionOverride ?? "rev-pinned",
        task_id: "rejudge-demo",
        files: [{ path: "rejudge-demo.eval.ts", content: evalContent }],
      });
    }
    if (url === `${BACKEND}/v1/agent-task-runs/${RUN_ID}/deliverables/dlv-report`) {
      return jsonResponse({ title: "Summary" });
    }
    if (url === `${BACKEND}/v1/agent-task-runs/${RUN_ID}/deliverables/dlv-memo`) {
      return new Response("memo body", { headers: { "Content-Type": "text/plain" } });
    }
    if (url === `${BACKEND}/v1/agent-task-runs/${RUN_ID}/trace-projection`) {
      return jsonResponse({ detail: "Task run has no trace" }, 409);
    }
    if (url === "http://judge.test/chat/completions") {
      const verdict = judgeResponses[judgeCall] ?? { pass: true, reasoning: "ok" };
      judgeCall += 1;
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(verdict) } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      });
    }
    return jsonResponse({ detail: `unexpected fetch: ${url}` }, 500);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("rejudgeTaskRun", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("replays checks against stored deliverables and returns the primary sample", async () => {
    const taskDir = makeTaskDir("happy", evalModule());
    const fetchMock = stubBackend({}, evalModule());

    const outcome = await rejudgeTaskRun(
      RUN_ID,
      { backendUrl: BACKEND, authToken: "key" },
      { taskDir, judge: { model: "test/judge" } },
    );

    expect(outcome.runId).toBe(RUN_ID);
    expect(outcome.definitionRevisionId).toBe("rev-pinned");
    expect(outcome.definitionRevisionIsPinned).toBe(true);
    expect(outcome.judge?.model).toBe("test/judge");
    expect(outcome.traceSnapshotAvailable).toBe(false);
    expect(outcome.taskDirUsed).toBe(taskDir);
    expect(outcome.pass).toBe(true);
    expect(outcome.checks.map((c) => c.id)).toEqual(["report-title", "fixture-file"]);

    // Deliverable bodies were fetched from the backend, not the adapter.
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(`${BACKEND}/v1/agent-task-runs/${RUN_ID}/deliverables/dlv-report`);
    expect(urls).toContain(`${BACKEND}/v1/agent-task-runs/${RUN_ID}/deliverables/dlv-memo`);
  });

  it("records per-check stability across samples", async () => {
    const taskDir = makeTaskDir("samples", evalModule({ withJudge: true }));
    stubBackend(
      {
        judgeResponses: [
          { pass: true, reasoning: "sample 1 pass" },
          { pass: false, reasoning: "sample 2 fail" },
          { pass: true, reasoning: "sample 3 pass" },
        ],
      },
      evalModule({ withJudge: true }),
    );

    const outcome = await rejudgeTaskRun(
      RUN_ID,
      { backendUrl: BACKEND, authToken: "key" },
      { taskDir, samples: 3, judge: { model: "test/judge", baseURL: "http://judge.test" } },
    );

    const judged = outcome.stability.find((s) => s.check_id === "judged-quality");
    expect(judged).toEqual({ check_id: "judged-quality", passes: 2, samples: 3 });
    // Primary sample is the first one.
    const primary = outcome.checks.find((c) => c.id === "judged-quality");
    expect(primary?.pass).toBe(true);
    // Deterministic code checks are stable across samples.
    const title = outcome.stability.find((s) => s.check_id === "report-title");
    expect(title).toEqual({ check_id: "report-title", passes: 3, samples: 3 });
  });

  it("refuses replay when a deliverable is not ready", async () => {
    const taskDir = makeTaskDir("notready", evalModule());
    stubBackend(
      {
        deliverables: [
          { id: "dlv-report", name: "report", kind: "json", status: "ready" },
          { id: "dlv-memo", name: "memo", kind: "artifact", status: "failed" },
        ],
      },
      evalModule(),
    );

    await expect(
      rejudgeTaskRun(RUN_ID, { backendUrl: BACKEND, authToken: "key" }, { taskDir }),
    ).rejects.toThrow(RejudgeError);
  });

  it("refuses replay for a non-terminal run", async () => {
    const taskDir = makeTaskDir("running", evalModule());
    stubBackend({ runStatus: "running" }, evalModule());

    await expect(
      rejudgeTaskRun(RUN_ID, { backendUrl: BACKEND, authToken: "key" }, { taskDir }),
    ).rejects.toThrow(/completed/);
  });

  it("requests an explicit definition revision and reports it as unpinned", async () => {
    const taskDir = makeTaskDir("revrev", evalModule());
    const fetchMock = stubBackend({ revisionOverride: "rev-other" }, evalModule());

    const outcome = await rejudgeTaskRun(
      RUN_ID,
      { backendUrl: BACKEND, authToken: "key" },
      { taskDir, definitionRevisionId: "rev-other" },
    );

    expect(outcome.definitionRevisionId).toBe("rev-other");
    expect(outcome.definitionRevisionIsPinned).toBe(false);
    const sourceUrl = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("definition-source"));
    expect(sourceUrl).toContain("revision=rev-other");
  });
});
