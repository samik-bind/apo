import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { basename, join } from "path";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { runTask } from "../src/agent-task/run/runTask";
import { normalizeRunConfiguration } from "../src/agent-task/run/run-configuration";
import type { AgentTaskRunConfiguration } from "../src/agent-task/public";

const TMP_ROOT = join(import.meta.dirname, "__run_configuration_test__");
let taskDir = "";
const LOCAL_DEFINE_ADAPTER_IMPORT = "../../../src/agent-task/adapter/defineAdapter";
const LOCAL_DEFINE_TASK_IMPORT = "../../../src/agent-task/task/defineTask";

// ---------------------------------------------------------------------------
// normalizeRunConfiguration (pure helper)
// ---------------------------------------------------------------------------

describe("normalizeRunConfiguration", () => {
  it("returns undefined when no configuration was reported", () => {
    expect(normalizeRunConfiguration(undefined)).toBeUndefined();
  });

  it("trims leading/trailing whitespace and preserves casing", () => {
    const result = normalizeRunConfiguration({
      model: "  gpt-5.6-terra  ",
      effort: "  high  ",
    });
    expect(result).toEqual({ model: "gpt-5.6-terra", effort: "high" });
  });

  it("drops an empty effort to undefined (not reported)", () => {
    const result = normalizeRunConfiguration({
      model: "claude-opus-4.1",
      effort: "   ",
    });
    expect(result).toEqual({ model: "claude-opus-4.1", effort: undefined });
  });

  it("preserves an explicit 'default' effort", () => {
    expect(
      normalizeRunConfiguration({ model: "claude-opus-4.1", effort: "default" }),
    ).toEqual({ model: "claude-opus-4.1", effort: "default" });
  });

  it("rejects a blank model", () => {
    expect(() => normalizeRunConfiguration({ model: "   " })).toThrow(
      /run_configuration\.model/,
    );
  });

  it("rejects a model over 255 UTF-8 bytes", () => {
    expect(() =>
      normalizeRunConfiguration({ model: "a".repeat(256) }),
    ).toThrow(/run_configuration\.model/);
  });

  it("rejects an effort over 64 UTF-8 bytes", () => {
    expect(() =>
      normalizeRunConfiguration({ model: "ok", effort: "b".repeat(65) }),
    ).toThrow(/run_configuration\.effort/);
  });

  it("rejects NUL and ASCII control characters", () => {
    expect(() =>
      normalizeRunConfiguration({ model: "bad\x00model" }),
    ).toThrow(/run_configuration\.model/);
    expect(() =>
      normalizeRunConfiguration({ model: "ok", effort: "high\x1f" }),
    ).toThrow(/run_configuration\.effort/);
  });

  it("counts UTF-8 bytes, not characters", () => {
    // 128 x 'é' (2 bytes each) = 256 bytes -> rejected.
    expect(() =>
      normalizeRunConfiguration({ model: "é".repeat(128) }),
    ).toThrow(/run_configuration\.model/);
  });
});

// ---------------------------------------------------------------------------
// Public entry-point export (adapter authors import the type here)
// ---------------------------------------------------------------------------

describe("AgentTaskRunConfiguration public type", () => {
  it("is constructible and carries model + optional effort", () => {
    const cfg: AgentTaskRunConfiguration = { model: "gpt-5.6-terra", effort: "high" };
    expect(cfg.model).toBe("gpt-5.6-terra");
    const minimal: AgentTaskRunConfiguration = { model: "claude-opus-4.1" };
    expect(minimal.effort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: runTask captures the adapter-reported configuration
// ---------------------------------------------------------------------------

describe("runTask run configuration capture", () => {
  beforeEach(() => {
    if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
    taskDir = join(
      TMP_ROOT,
      `case-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  });

  afterAll(() => {
    if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("carries the adapter's resolved configuration through the no-trace path", async () => {
    setupTaskDir({
      runConfiguration: { model: "gpt-5.6-terra", effort: "high" },
    });

    const result = await runTask(taskDir);

    expect(result.runConfiguration).toEqual({
      model: "gpt-5.6-terra",
      effort: "high",
    });
  });

  it("carries the adapter's resolved configuration through the tracing path", async () => {
    setupTaskDir({
      runConfiguration: { model: "gpt-5.6-terra", effort: "high" },
    });

    const result = await runTask(taskDir, {
      tracing: {
        client: {
          traceRun: async (_params, fn) =>
            fn({
              runId: "trace-run-1",
              rootSpanId: "root-span-1",
              async step(_options, stepFn) {
                return stepFn("span-1");
              },
              recordEvent() {
                return "event-1";
              },
              endRoot() {},
            }),
        },
        project: "sdk-tests",
      },
    });

    expect(result.runConfiguration).toEqual({
      model: "gpt-5.6-terra",
      effort: "high",
    });
  });

  it("omits runConfiguration when an old adapter does not report one", async () => {
    setupTaskDir({ runConfiguration: undefined });

    const result = await runTask(taskDir);

    expect(result.runConfiguration).toBeUndefined();
    expect(result.result.pass).toBe(true);
  });

  it("fails before the first turn when the configuration is invalid", async () => {
    // sendUserTurn throws a distinctive marker so the test can prove it was
    // never reached: the rejection must be the validation error, not the marker.
    setupTaskDir({
      runConfiguration: { model: "   " },
      sendUserTurnMarker: "SEND_USER_TURN_WAS_CALLED",
    });

    await expect(runTask(taskDir)).rejects.toThrow(/run_configuration\.model/);

    // Re-run and assert the marker never appears in any thrown message.
    await expect(runTask(taskDir)).rejects.not.toThrow(
      /SEND_USER_TURN_WAS_CALLED/,
    );
  });

  function setupTaskDir(options: {
    runConfiguration?: { model: string; effort?: string };
    sendUserTurnMarker?: string;
  }): void {
    mkdirSync(taskDir, { recursive: true });
    const marker = options.sendUserTurnMarker;
    const sendUserTurnBody = marker
      ? `throw new Error(${JSON.stringify(marker)});`
      : `return { response: "ack:" + String(turn) };`;
    const runConfigurationValue = options.runConfiguration
      ? JSON.stringify(options.runConfiguration)
      : "undefined";

    writeFileSync(
      join(taskDir, "adapter.ts"),
      `import { z } from "zod";
import { defineAdapter } from "${LOCAL_DEFINE_ADAPTER_IMPORT}";

export const testAdapter = defineAdapter({
  name: "test-adapter",
  deliverables: {
    report: z.object({ title: z.string(), overview: z.string() }),
  },
  turn: async ({ transcript }) => {
    if (transcript.length > 0) return null;
    return "test-prompt";
  },
  async startSession() {
    return {
      runConfiguration: ${runConfigurationValue},
      async sendUserTurn(turn: unknown) {
        ${sendUserTurnBody}
      },
    };
  },
  async collectDeliverables() {
    return { report: { title: "Summary", overview: "ok" } };
  },
});
`,
    );

    writeFileSync(
      join(taskDir, `${basename(taskDir)}.eval.ts`),
      `import { defineTask } from "${LOCAL_DEFINE_TASK_IMPORT}";
import { testAdapter } from "./adapter";

export default defineTask(testAdapter, {
  id: "cfg-task",
  description: "run configuration capture",
  deliverables: ["report"],
});
`,
    );

    writeFileSync(
      join(taskDir, "checks.ts"),
      `import { includes, test } from "../../../src/agent-task/public";
test("overview", (t, { deliverables }) => {
  t.check((deliverables.report as { overview: string }).overview, includes("ok"));
});
`,
    );
  }
});
