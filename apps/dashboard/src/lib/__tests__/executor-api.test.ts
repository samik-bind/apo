import { describe, expect, it } from "vitest";
import {
  getDefaultExecutorPool,
  isSelectableExecutorPool,
  type ExecutorPoolSummary,
} from "../executor-api";

function pool(overrides: Partial<ExecutorPoolSummary>): ExecutorPoolSummary {
  return {
    id: "pool-1",
    name: "Bundled Executor",
    slug: "bundled",
    kind: "bundled",
    enabled: true,
    archived: false,
    is_default: false,
    health: "offline",
    online_executor_count: 0,
    available_capacity: 0,
    queue_ttl_seconds: 86_400,
    required_driver_kind: "subprocess",
    ...overrides,
  };
}

describe("executor pool selection", () => {
  it("preselects only the valid Project default", () => {
    const nonDefault = pool({ id: "pool-a" });
    const selected = pool({ id: "pool-b", is_default: true });
    expect(getDefaultExecutorPool([nonDefault, selected])).toEqual(selected);
  });

  it("does not silently select a random Pool when no default exists", () => {
    expect(getDefaultExecutorPool([pool({ id: "pool-a" })])).toBeNull();
  });

  it("allows offline Pools but rejects disabled and archived Pools", () => {
    expect(isSelectableExecutorPool(pool({ health: "offline" }))).toBe(true);
    expect(isSelectableExecutorPool(pool({ enabled: false }))).toBe(false);
    expect(isSelectableExecutorPool(pool({ archived: true }))).toBe(false);
  });
});
