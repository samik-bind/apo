import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CallDetailTabs } from "../CallDetailTabs";
import { TraceEventPreview } from "../TraceEventPreview";

const LONG_FINDING =
  "The agreement is a three-year master services agreement with a mutual " +
  "termination-for-convenience right on 90 days notice, and the exhibits it " +
  "incorporates are expressly absent.";

const structuredAnswer = JSON.stringify({
  gist: LONG_FINDING,
  notes: [{ sev: "high", what: "Exhibits are incorporated but absent." }],
});

/** ExpandableJson's filter box — present only when a tree was rendered. */
function jsonTree(): HTMLElement | null {
  return screen.queryByLabelText("Filter JSON content");
}

/** Markdown puts the whole payload in one paragraph; a tree never does. */
function paragraphWith(text: string): boolean {
  return Array.from(document.querySelectorAll("p")).some((p) =>
    p.textContent?.includes(text),
  );
}

describe("CallDetailTabs readable text", () => {
  // apo's own SDK records a generation's output as `{ text }`, so a structured
  // answer reaches the trace-level Output panel in this shape.
  it("renders a { text } payload that is JSON as a tree", () => {
    render(<CallDetailTabs data={{ text: structuredAnswer }} title="Output" />);

    expect(jsonTree()).toBeInTheDocument();
    expect(paragraphWith("gist")).toBe(false);
    expect(screen.getByText(/Exhibits are incorporated/)).toBeInTheDocument();
    // Nothing elided: no collapsed node and no truncated string.
    expect(screen.getByText(new RegExp(LONG_FINDING.slice(-40)))).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+ chars\)/)).toBeNull();
  });

  it("renders a { text } payload that is prose as markdown", () => {
    render(
      <CallDetailTabs data={{ text: "## Findings\n\nThe term is five years." }} title="Output" />,
    );

    expect(jsonTree()).toBeNull();
    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
  });
});

describe("TraceEventPreview assistant message", () => {
  const assistantEvent = (text: string) => ({ type: "assistant_message", text });

  it("renders a JSON payload as a tree", () => {
    render(<TraceEventPreview data={assistantEvent(structuredAnswer)} />);

    expect(jsonTree()).toBeInTheDocument();
    expect(screen.getByText("JSON")).toBeInTheDocument();
  });

  it.each(["```json", "```"])(
    "unwraps a %s fenced block — unlike a chat message, this panel shows a tree",
    (fence) => {
      render(
        <TraceEventPreview data={assistantEvent(fence + "\n" + structuredAnswer + "\n```")} />,
      );

      expect(jsonTree()).toBeInTheDocument();
    },
  );

  it("keeps a payload carrying a BOM — String.trim strips more than JSON's whitespace", () => {
    render(<TraceEventPreview data={assistantEvent("﻿" + structuredAnswer)} />);

    expect(jsonTree()).toBeInTheDocument();
  });

  it("renders prose as markdown", () => {
    render(<TraceEventPreview data={assistantEvent("I reviewed the agreement.")} />);

    expect(jsonTree()).toBeNull();
    expect(screen.getByText("I reviewed the agreement.")).toBeInTheDocument();
  });
});
