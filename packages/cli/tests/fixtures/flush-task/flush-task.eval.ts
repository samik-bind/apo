/**
 * Fixture Task for the piped-output regression test (#155).
 *
 * Deliberately deterministic: the adapter runs one turn with no LLM and no
 * external I/O, and every check fails — so `apo task run` always exits 1 on
 * the FAIL verdict path after printing the checks summary and the
 * Run:/Inspect: identity lines.
 *
 * Volume matters: the summary must exceed the OS pipe buffer (64 KiB) so
 * that, with a slow pipe consumer, the child's final writes back up in the
 * userspace write queue — the exact condition under which a bare
 * `process.exit` truncated the identity lines before the flush fix (#155).
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

const { test: check } = task("flush-fixture", {
  // The adapter shape is structural; cast through the typed boundary so the
  // fixture stays free of the SDK's full generic plumbing.
  adapter: deterministicAdapter as never,
  deliverables: ["result"],
  maxTurns: 1,
});

// ~150 KiB of check lines: enough to overflow the 64 KiB pipe buffer even
// after the summary header, forcing the tail into the userspace queue.
for (let i = 0; i < 3000; i++) {
  check(`volume-failing-check-${String(i).padStart(4, "0")}-xxxxxxxxxxxxxxxxxxxxxxxx`, (t) => {
    t.assert("deterministically fails", () => false);
  });
}
