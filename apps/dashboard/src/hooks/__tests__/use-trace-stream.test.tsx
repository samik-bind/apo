import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  getBrowserBackendBaseUrl: () => "http://backend.test",
}));

vi.mock("@/lib/backend-fetch", () => ({
  toBrowserProxyUrl: (url: string) => url,
}));

import { useTraceStream } from "../use-trace-stream";

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function TraceStreamConsumer() {
  useTraceStream("trace-1");
  return null;
}

describe("useTraceStream reconnect backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps increasing the delay while reconnects fail before opening", () => {
    render(<TraceStreamConsumer />);
    expect(FakeEventSource.instances).toHaveLength(1);

    act(() => FakeEventSource.instances[0].onerror?.());
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeEventSource.instances).toHaveLength(2);

    act(() => FakeEventSource.instances[1].onerror?.());
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(3_000));
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it("resets the failure streak after a connection opens", () => {
    render(<TraceStreamConsumer />);
    act(() => FakeEventSource.instances[0].onerror?.());
    act(() => vi.advanceTimersByTime(3_000));

    act(() => FakeEventSource.instances[1].onopen?.());
    act(() => FakeEventSource.instances[1].onerror?.());
    act(() => vi.advanceTimersByTime(3_000));

    expect(FakeEventSource.instances).toHaveLength(3);
  });
});
