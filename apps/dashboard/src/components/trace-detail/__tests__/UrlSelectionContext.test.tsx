import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const replaceMock = vi.fn();
const pushMock = vi.fn();
let searchParams: URLSearchParams;
let pathname: string;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
}));

import {
  UrlSelectionProvider,
} from "../contexts/UrlSelectionContext";
import { useSelection } from "../contexts/SelectionContext";

function Consumer() {
  const {
    selectedRunId,
    selectedCallId,
    view,
    detailTab,
    selectCall,
    selectRun,
    clearSelection,
    setView,
    setDetailTab,
  } = useSelection();
  return (
    <div>
      <span data-testid="selectedRunId">{String(selectedRunId)}</span>
      <span data-testid="selectedCallId">{String(selectedCallId)}</span>
      <span data-testid="view">{view}</span>
      <span data-testid="detailTab">{detailTab}</span>
      <button type="button" data-testid="select-call" onClick={() => selectCall("call-123")} />
      <button type="button" data-testid="select-null" onClick={() => selectCall(null)} />
      <button type="button" data-testid="select-run-same" onClick={() => selectRun("run-1")} />
      <button type="button" data-testid="clear" onClick={clearSelection} />
      <button type="button" data-testid="set-view-timeline" onClick={() => setView("timeline")} />
      <button type="button" data-testid="set-tab-tokens" onClick={() => setDetailTab("tokens")} />
    </div>
  );
}

function renderWithProvider(
  ui: React.ReactElement,
  runId = "run-1",
) {
  return render(<UrlSelectionProvider runId={runId}>{ui}</UrlSelectionProvider>);
}

let historySpy: ReturnType<typeof vi.spyOn>;

/**
 * Selection updates are shallow (`window.history.replaceState`), so they read
 * and write the real jsdom URL. Keep the mocked `useSearchParams` (initial
 * render reads) and `window.location` (update reads/writes) in sync.
 */
function setLocation(params = "") {
  searchParams = new URLSearchParams(params);
  const qs = searchParams.toString();
  window.history.replaceState(null, "", `${pathname}${qs ? `?${qs}` : ""}`);
  historySpy?.mockClear();
}

function currentUrl(): string {
  return `${window.location.pathname}${window.location.search}`;
}

beforeEach(() => {
  replaceMock.mockReset();
  pushMock.mockReset();
  pathname = "/project/test/traces/run-1";
  setLocation();
  historySpy = vi.spyOn(window.history, "replaceState");
});

afterEach(() => {
  historySpy.mockRestore();
});

describe("UrlSelectionContext - initial state from URL", () => {
  it("defaults to tree view and empty tab when no params", () => {
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("view").textContent).toBe("tree");
    expect(screen.getByTestId("detailTab").textContent).toBe("");
    expect(screen.getByTestId("selectedCallId").textContent).toBe("null");
  });

  it("reads observation param from URL on mount", () => {
    setLocation("observation=call-abc");
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("selectedCallId").textContent).toBe("call-abc");
  });

  it("reads view param from URL on mount", () => {
    setLocation("view=timeline");
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("view").textContent).toBe("timeline");
  });

  it("reads tab param from URL on mount", () => {
    setLocation("tab=tokens");
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("detailTab").textContent).toBe("tokens");
  });

  it("exposes the current runId as selectedRunId", () => {
    renderWithProvider(<Consumer />, "run-xyz");
    expect(screen.getByTestId("selectedRunId").textContent).toBe("run-xyz");
  });
});

describe("UrlSelectionContext - view param validation", () => {
  it("falls back to tree for invalid view param", () => {
    setLocation("view=invalid-mode");
    renderWithProvider(<Consumer />);
    expect(screen.getByTestId("view").textContent).toBe("tree");
  });

  it("supports all valid view values", () => {
    for (const v of ["tree", "timeline", "graph"] as const) {
      setLocation(`view=${v}`);
      const { unmount } = renderWithProvider(<Consumer />);
      expect(screen.getByTestId("view").textContent).toBe(v);
      unmount();
    }
  });
});

describe("UrlSelectionContext - selectCall syncs URL", () => {
  it("sets observation param when selecting a call", () => {
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("select-call").click());

    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(currentUrl()).toContain("observation=call-123");
  });

  it("removes observation param when selecting null", () => {
    setLocation("observation=call-old");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("select-null").click());

    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(currentUrl()).not.toContain("observation=");
  });

  it("clearSelection removes observation param", () => {
    setLocation("observation=call-old");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("clear").click());

    expect(currentUrl()).not.toContain("observation=");
  });

  it("preserves other params when updating observation", () => {
    setLocation("view=timeline&tab=tokens");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("select-call").click());

    const url = currentUrl();
    expect(url).toContain("observation=call-123");
    expect(url).toContain("view=timeline");
    expect(url).toContain("tab=tokens");
  });

  it("composes rapid successive updates from the live URL", () => {
    renderWithProvider(<Consumer />);
    // The mocked useSearchParams never updates, so both params surviving
    // proves updates read window.location rather than the (stale) hook.
    act(() => screen.getByTestId("select-call").click());
    act(() => screen.getByTestId("set-view-timeline").click());

    const url = currentUrl();
    expect(url).toContain("observation=call-123");
    expect(url).toContain("view=timeline");
  });
});

describe("UrlSelectionContext - selectRun behavior", () => {
  it("clears call selection when selecting the current run", () => {
    setLocation("observation=call-old");
    renderWithProvider(<Consumer />, "run-1");
    act(() => screen.getByTestId("select-run-same").click());

    expect(currentUrl()).not.toContain("observation=");
  });
});

describe("UrlSelectionContext - view sync", () => {
  it("sets view param via setView", () => {
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("set-view-timeline").click());

    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(currentUrl()).toContain("view=timeline");
  });

  it("preserves observation when updating view", () => {
    setLocation("observation=call-x");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("set-view-timeline").click());

    const url = currentUrl();
    expect(url).toContain("view=timeline");
    expect(url).toContain("observation=call-x");
  });
});

describe("UrlSelectionContext - detail tab sync", () => {
  it("sets tab param via setDetailTab", () => {
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("set-tab-tokens").click());

    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(currentUrl()).toContain("tab=tokens");
  });

  it("preserves observation and view when updating tab", () => {
    setLocation("observation=call-x&view=timeline");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("set-tab-tokens").click());

    const url = currentUrl();
    expect(url).toContain("tab=tokens");
    expect(url).toContain("observation=call-x");
    expect(url).toContain("view=timeline");
  });
});

describe("UrlSelectionContext - URL construction", () => {
  it("preserves the current pathname in the updated URL", () => {
    pathname = "/project/test/traces/run-42";
    setLocation();
    renderWithProvider(<Consumer />, "run-42");
    act(() => screen.getByTestId("select-call").click());

    expect(currentUrl()).toContain("/project/test/traces/run-42");
  });

  it("omits the query string entirely when no params remain", () => {
    setLocation("observation=only-one");
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("clear").click());

    expect(currentUrl()).toBe("/project/test/traces/run-1");
  });

  it("updates shallowly without a router navigation", () => {
    renderWithProvider(<Consumer />);
    act(() => screen.getByTestId("select-call").click());

    // The whole point of the shallow update: the URL changes but the router
    // never navigates, so the server component is not re-rendered.
    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("UrlSelectionContext - throw outside provider", () => {
  it("throws when useSelection is used outside provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
      render(<Consumer />);
    }).toThrow("useSelection must be used within SelectionProvider");

    consoleError.mockRestore();
  });
});
