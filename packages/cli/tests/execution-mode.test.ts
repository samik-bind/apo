import { describe, expect, it } from "vitest";
import { resolveExecutionMode } from "../src/lib/execution-mode.ts";

function expectMode(input: Parameters<typeof resolveExecutionMode>[0], expected: string) {
  expect(resolveExecutionMode(input).mode).toBe(expected);
}

describe("resolveExecutionMode — SPEC-165: caller is the default", () => {
  it("--local flag → local-recorded", () => {
    expectMode({ flagLocal: true, hasProject: true }, "local-recorded");
  });

  it("has project, no flags → local-recorded (caller is the default)", () => {
    expectMode({ hasProject: true }, "local-recorded");
  });

  it("no project → local-unrecorded", () => {
    expectMode({ hasProject: false }, "local-unrecorded");
  });

  it("reason for a flag-driven decision is 'flag'", () => {
    expect(resolveExecutionMode({ flagLocal: true, hasProject: true }).reason).toBe("flag");
  });

  it("reason for the default is 'default'", () => {
    expect(resolveExecutionMode({ hasProject: true }).reason).toBe("default");
  });
});
