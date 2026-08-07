import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

const replaceMock = vi.fn();
const pushMock = vi.fn();
let searchParams: URLSearchParams;
let pathname: string;

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (...args: unknown[]) => replaceMock(...args),
    push: (...args: unknown[]) => pushMock(...args),
  }),
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
}));

import { useUrlParam, useUrlParamSet } from "../use-url-state";

let historySpy: ReturnType<typeof vi.spyOn>;

/**
 * Writes are shallow (`window.history.replaceState`), so they read and write
 * the real jsdom URL. Keep the mocked `useSearchParams` (initial render reads)
 * and `window.location` (update reads/writes) in sync.
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

/** Extract the value of one param from the current URL. */
function paramFromUrl(key: string): string {
  return new URLSearchParams(window.location.search).get(key) ?? "";
}

beforeEach(() => {
  replaceMock.mockReset();
  pushMock.mockReset();
  pathname = "/project/test/runs/run-1";
  setLocation();
  historySpy = vi.spyOn(window.history, "replaceState");
});

afterEach(() => {
  historySpy.mockRestore();
});

// ── useUrlParam ──────────────────────────────────────────────────────────

function ParamConsumer({ paramKey, fallback }: { paramKey: string; fallback?: string }) {
  const [value, setValue] = useUrlParam(paramKey, fallback);
  return (
    <div>
      <span data-testid="value">{value}</span>
      <button type="button" data-testid="set" onClick={() => setValue("next")} />
      <button type="button" data-testid="clear" onClick={() => setValue(null)} />
    </div>
  );
}

describe("useUrlParam - initial state from URL", () => {
  it("reads value from URL on mount", () => {
    setLocation("q=hello");
    render(<ParamConsumer paramKey="q" />);
    expect(screen.getByTestId("value").textContent).toBe("hello");
  });

  it("falls back to empty when param absent", () => {
    render(<ParamConsumer paramKey="q" />);
    expect(screen.getByTestId("value").textContent).toBe("");
  });

  it("honors a provided fallback", () => {
    render(<ParamConsumer paramKey="filter" fallback="all" />);
    expect(screen.getByTestId("value").textContent).toBe("all");
  });
});

describe("useUrlParam - writes sync URL shallowly", () => {
  it("sets the param via a shallow history update, not a router navigation", () => {
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("set").click());

    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(currentUrl()).toContain("q=next");
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("removes the param when set to null", () => {
    setLocation("q=stale");
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("clear").click());

    expect(currentUrl()).not.toContain("q=");
  });

  it("preserves other params when writing", () => {
    setLocation("filter=failed&tab=checks");
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("set").click());

    const url = currentUrl();
    expect(url).toContain("q=next");
    expect(url).toContain("filter=failed");
    expect(url).toContain("tab=checks");
  });

  it("keeps pathname in the updated URL", () => {
    pathname = "/project/p1/runs/task/abc";
    setLocation();
    render(<ParamConsumer paramKey="tab" />);
    act(() => screen.getByTestId("set").click());
    expect(currentUrl()).toContain("/project/p1/runs/task/abc");
  });

  it("omits query string entirely when no params remain", () => {
    setLocation("q=only");
    render(<ParamConsumer paramKey="q" />);
    act(() => screen.getByTestId("clear").click());
    expect(currentUrl()).toBe("/project/test/runs/run-1");
  });
});

// ── useUrlParamSet ───────────────────────────────────────────────────────

function SetConsumer({ paramKey }: { paramKey: string }) {
  const [set, toggle] = useUrlParamSet(paramKey);
  return (
    <div>
      <span data-testid="set">{Array.from(set).join(",")}</span>
      <button type="button" data-testid="add-a" onClick={() => toggle("a")} />
      <button type="button" data-testid="add-b" onClick={() => toggle("b")} />
      <button type="button" data-testid="remove-a" onClick={() => toggle("a", false)} />
      <button type="button" data-testid="force-add-a" onClick={() => toggle("a", true)} />
    </div>
  );
}

describe("useUrlParamSet - reads comma-separated values from URL", () => {
  beforeEach(() => {
    pathname = "/project/test/runs/task/x";
    setLocation();
  });

  it("parses multiple values from URL on mount", () => {
    setLocation("check=a,b,c");
    render(<SetConsumer paramKey="check" />);
    expect(screen.getByTestId("set").textContent).toBe("a,b,c");
  });

  it("starts empty when param absent", () => {
    render(<SetConsumer paramKey="check" />);
    expect(screen.getByTestId("set").textContent).toBe("");
  });

  it("trims whitespace and ignores empty entries", () => {
    setLocation("check= a ,,b,");
    render(<SetConsumer paramKey="check" />);
    expect(screen.getByTestId("set").textContent).toBe("a,b");
  });
});

describe("useUrlParamSet - toggle writes to URL", () => {
  beforeEach(() => {
    pathname = "/project/test/runs/task/x";
    setLocation();
  });

  it("adds a value via a shallow history update, not a router navigation", () => {
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("add-a").click());

    expect(historySpy).toHaveBeenCalledTimes(1);
    expect(paramFromUrl("check")).toBe("a");
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("accumulates values across successive toggles from the live URL", () => {
    // No re-render happens between clicks (the mocked useSearchParams is
    // static), so both values surviving proves toggle reads the live URL
    // rather than a stale hook snapshot.
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("add-a").click());
    act(() => screen.getByTestId("add-b").click());

    expect(paramFromUrl("check")).toBe("a,b");
  });

  it("removes a value when toggled off", () => {
    setLocation("check=a,b");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("add-a").click());

    expect(paramFromUrl("check")).toBe("b");
  });

  it("respects explicit open=false", () => {
    setLocation("check=a");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("remove-a").click());
    expect(currentUrl()).not.toContain("check=");
  });

  it("respects explicit open=true even if already present", () => {
    setLocation("check=a");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("force-add-a").click());
    expect(paramFromUrl("check")).toBe("a");
  });

  it("preserves other params", () => {
    setLocation("tab=checks&other=1");
    render(<SetConsumer paramKey="check" />);
    act(() => screen.getByTestId("add-a").click());

    const url = currentUrl();
    expect(url).toContain("check=a");
    expect(url).toContain("tab=checks");
    expect(url).toContain("other=1");
  });
});
