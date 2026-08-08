import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getTraceDetailMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/traces-api", () => ({
  getTraceDetail: getTraceDetailMock,
}));

vi.mock("@/lib/conversation-from-trace", () => ({
  deriveConversationFromTrace: () => ({ messages: [] }),
}));

import { useLazyConversation } from "./use-lazy-conversation";

describe("useLazyConversation", () => {
  beforeEach(() => {
    getTraceDetailMock.mockReset();
    getTraceDetailMock.mockReturnValue(new Promise(() => {}));
  });

  it("starts loading when a running task receives its trace ID later", () => {
    const { result, rerender } = renderHook(
      ({ traceRunId }) =>
        useLazyConversation(traceRunId, "project-1", true),
      { initialProps: { traceRunId: null as string | null } },
    );
    expect(result.current).toEqual({ status: "ready", messages: [] });

    rerender({ traceRunId: "trace-1" });

    expect(result.current.status).toBe("loading");
    expect(getTraceDetailMock).toHaveBeenCalledOnce();
    expect(getTraceDetailMock).toHaveBeenCalledWith(
      "trace-1",
      "project-1",
      expect.any(AbortSignal),
    );
  });

  it("aborts an interrupted load and retries when the tab reopens", () => {
    const { rerender } = renderHook(
      ({ enabled }) =>
        useLazyConversation("trace-1", "project-1", enabled),
      { initialProps: { enabled: true } },
    );
    const firstSignal = getTraceDetailMock.mock.calls[0][2] as AbortSignal;

    act(() => rerender({ enabled: false }));
    expect(firstSignal.aborted).toBe(true);

    act(() => rerender({ enabled: true }));
    expect(getTraceDetailMock).toHaveBeenCalledTimes(2);
    const secondSignal = getTraceDetailMock.mock.calls[1][2] as AbortSignal;
    expect(secondSignal.aborted).toBe(false);
  });
});
