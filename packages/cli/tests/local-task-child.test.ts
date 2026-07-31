import { describe, expect, it } from "vitest";
import { buildChildEnv } from "../src/lib/local-task-child.ts";

const baseOpts = {
  taskDir: "/tmp/task",
  envRoot: "/tmp",
  traceEndpoint: "http://cp/otel",
  project: "acme",
  taskRunId: "run-1",
  traceRequired: true,
  attemptJwt: "attempt-jwt",
  timeoutSeconds: 60,
};

describe("SPEC-161 local-task-child environment", () => {
  it("injects the task-scoped Apo values and the scoped Attempt token", () => {
    const env = buildChildEnv({ ...baseOpts });
    expect(env.AGENT_TASK_TRACE_ENDPOINT).toBe("http://cp/otel");
    expect(env.AGENT_TASK_PROJECT).toBe("acme");
    expect(env.AGENT_TASK_RUN_ID).toBe("run-1");
    expect(env.AGENT_TASK_TRACE_REQUIRED).toBe("true");
    expect(env.APO_AUTH_TOKEN).toBe("attempt-jwt");
    expect(env.APO_CHILD_TASK_DIR).toBe("/tmp/task");
  });

  it("strips the User API key, Executor Credential, enrollment tokens, and any previous auth token", () => {
    process.env.APO_API_KEY = "sk-leak";
    process.env.APO_EXECUTOR_CREDENTIAL = "apo_ex_leak";
    process.env.APO_ENROLLMENT_TOKEN = "apo_enroll_leak";
    process.env.APO_BOOTSTRAP_TOKEN = "apo_boot_leak";
    process.env.APO_AUTH_TOKEN = "previous-user-token";
    try {
      const env = buildChildEnv({ ...baseOpts });
      expect(env.APO_API_KEY).toBeUndefined();
      expect(env.APO_EXECUTOR_CREDENTIAL).toBeUndefined();
      expect(env.APO_ENROLLMENT_TOKEN).toBeUndefined();
      expect(env.APO_BOOTSTRAP_TOKEN).toBeUndefined();
      // The previous user token is replaced by the scoped Attempt token.
      expect(env.APO_AUTH_TOKEN).toBe("attempt-jwt");
    } finally {
      delete process.env.APO_API_KEY;
      delete process.env.APO_EXECUTOR_CREDENTIAL;
      delete process.env.APO_ENROLLMENT_TOKEN;
      delete process.env.APO_BOOTSTRAP_TOKEN;
      delete process.env.APO_AUTH_TOKEN;
    }
  });

  it("marks trace_required false when not required", () => {
    const env = buildChildEnv({ ...baseOpts, traceRequired: false });
    expect(env.AGENT_TASK_TRACE_REQUIRED).toBe("false");
  });
});
