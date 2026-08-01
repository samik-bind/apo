/**
 * Fixture Task for the real `apo connect` scene test.
 *
 * Deliberately deterministic: the adapter runs one turn with no LLM and no
 * external I/O, so the scene test can assert the full claim → attestation →
 * start → child → result contract without provider credentials. The eval file
 * imports the SDK by relative path so the spawned child process can resolve it
 * from this fixture directory.
 */
import { task } from "../../../../sdk/src/agent-task/public.ts";

const deterministicAdapter = {
  name: "deterministic",
  deliverables: { result: null },
  turn: async () => "fixture-user-turn",
  startSession: async () => ({
    runConfiguration: { model: "deterministic-fixture", effort: "low" },
    sendUserTurn: async () => ({ response: "fixture-response" }),
  }),
  collectDeliverables: async () => ({ result: "fixture-output" }),
};

const { test: check } = task("connect-fixture", {
  // The adapter shape is structural; cast through the typed boundary so the
  // fixture stays free of the SDK's full generic plumbing.
  adapter: deterministicAdapter as never,
  deliverables: ["result"],
  maxTurns: 1,
});

check("always-passes", (t) => {
  t.usedNoTools();
});
