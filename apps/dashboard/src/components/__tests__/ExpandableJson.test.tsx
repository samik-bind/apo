import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExpandableJson } from "../ExpandableJson";

/** Long enough to trip the tree's string truncation, deep enough to collapse. */
const LONG_VALUE =
  "The agreement is a three-year master services agreement with a mutual " +
  "termination-for-convenience right on 90 days notice, and the exhibits it " +
  "incorporates are expressly absent.";

const payload = {
  gist: LONG_VALUE,
  notes: [{ sev: "high", what: "Exhibits are incorporated but absent." }],
};

/** The `(N chars)` marker the tree appends to an elided string value. */
const truncationMarker = () => screen.queryByText(/\(\d+ chars\)/);

describe("ExpandableJson initialDetail", () => {
  // ~14 call sites render reference material and rely on this default; a
  // change to it would quietly expand every tool result and deliverable.
  it("defaults to summary — deep nodes collapsed, long strings elided", () => {
    render(<ExpandableJson data={payload} />);

    expect(truncationMarker()).toBeInTheDocument();
    expect(screen.queryByText(/Exhibits are incorporated/)).toBeNull();
    // A 120-char slice is as likely an id or a path as prose, so it may break
    // anywhere.
    expect(
      screen.getByText(new RegExp(LONG_VALUE.slice(0, 40))).className,
    ).toContain('break-all');
  });

  it("hides nothing under full", () => {
    render(<ExpandableJson data={payload} initialDetail="full" />);

    expect(truncationMarker()).toBeNull();
    expect(screen.getByText(/Exhibits are incorporated/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(LONG_VALUE.slice(-40)))).toBeInTheDocument();
  });

  it("wraps a whole value on word boundaries, not mid-word", () => {
    render(<ExpandableJson data={payload} initialDetail="full" />);

    const value = screen.getByText(new RegExp(LONG_VALUE.slice(-40)));
    expect(value.className).toContain("break-words");
    expect(value.className).not.toContain("break-all");
    expect(value.className).not.toContain("whitespace-nowrap");
    // The row wrapping that value carries the same mode: it also holds the
    // non-string values and the collapsed {…} previews.
    expect(value.parentElement!.className).toContain("break-words");
  });

  it("still honours the toolbar's no-wrap mode", async () => {
    const user = userEvent.setup();
    render(<ExpandableJson data={payload} initialDetail="full" />);

    // The chip cycles truncate → wrap → nowrap; full mode starts at wrap.
    await user.click(screen.getByLabelText("String mode: Wrap"));

    const value = screen.getByText(new RegExp(LONG_VALUE.slice(-40)));
    expect(value.className).toContain("whitespace-nowrap");
    expect(value.parentElement!.className).toContain("whitespace-nowrap");
  });

  // Only the collapse half re-derives. The string mode is seeded at mount and
  // stays there because the toolbar also writes it — deriving it from the prop
  // would clobber the reader's own choice on any parent re-render.
  it("re-collapses when the prop changes on a mounted tree", () => {
    const { rerender } = render(
      <ExpandableJson data={payload} initialDetail="full" />,
    );
    expect(screen.getByText(/Exhibits are incorporated/)).toBeInTheDocument();

    rerender(<ExpandableJson data={payload} initialDetail="summary" />);
    expect(screen.queryByText(/Exhibits are incorporated/)).toBeNull();
  });

  // Row virtualization positions rows at index * ROW_HEIGHT, which only holds
  // while rows are one line — so it must stay off when values wrap, or the
  // tail of a large payload becomes unreachable.
  it("renders every row of a large payload under full, without virtualizing", () => {
    const many = { notes: Array.from({ length: 1200 }, (_, i) => `finding-${i}`) };
    render(<ExpandableJson data={many} initialDetail="full" />);

    expect(screen.getByText(/finding-1199/)).toBeInTheDocument();
  });
});
