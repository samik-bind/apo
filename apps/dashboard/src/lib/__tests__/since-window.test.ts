/**
 * The shared date-window vocabulary.
 *
 * Tasks and Runs used to keep separate preset lists, so a window picked on one
 * page could arrive at the other as a value it could neither apply nor
 * display. The presets are one list now, and anything outside it still has to
 * survive the trip: the backend accepts any `Nh`/`Nd`, so an old `24h`
 * bookmark must stay selectable rather than blanking the control.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_SINCE_VALUE,
  SINCE_PRESETS,
  sinceLabel,
  sinceOptionsFor,
} from "../since-window";

const values = (options: { value: string }[]) => options.map((o) => o.value);

describe("sinceLabel", () => {
  it("names a preset", () => {
    expect(sinceLabel("7d")).toBe("7 days");
  });

  it("derives a label for a window outside the presets", () => {
    expect(sinceLabel("24h")).toBe("24 hours");
    expect(sinceLabel("90d")).toBe("90 days");
  });

  it("keeps the singular for a window of one", () => {
    expect(sinceLabel("1h")).toBe("1 hour");
    expect(sinceLabel("1d")).toBe("1 day");
  });

  it("passes an unparseable value through untouched", () => {
    expect(sinceLabel("last-tuesday")).toBe("last-tuesday");
  });
});

describe("sinceOptionsFor", () => {
  it("offers all time plus every preset", () => {
    expect(values(sinceOptionsFor(null))).toEqual([
      ALL_SINCE_VALUE,
      ...SINCE_PRESETS.map((p) => p.value),
    ]);
  });

  it("adds nothing when the current window is already a preset", () => {
    expect(sinceOptionsFor("7d")).toHaveLength(SINCE_PRESETS.length + 1);
  });

  it("keeps a window outside the presets selectable", () => {
    const options = sinceOptionsFor("24h");
    expect(options).toContainEqual({ value: "24h", label: "24 hours" });
  });
});
