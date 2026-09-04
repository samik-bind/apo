import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConversationTranscript } from "../conversation-transcript";
import type { ChatMessage } from "@/lib/conversation-from-trace";

/**
 * Like a real structured answer: leaves two levels down, and substance in
 * string values well past the tree's 120-char truncation point.
 */
const LONG_FINDING =
  "The agreement is a three-year master services agreement with a mutual " +
  "termination-for-convenience right on 90 days notice, and the exhibits it " +
  "incorporates are expressly absent.";

const structuredAnswer = JSON.stringify({
  gist: LONG_FINDING,
  exhibits_missing: true,
  notes: [
    { sev: "high", what: "Exhibits are incorporated but absent." },
    { sev: "medium", what: "Transition costs are open-ended." },
  ],
});

function transcript(messages: ChatMessage[]) {
  return render(<ConversationTranscript conversation={messages} />);
}

/** ExpandableJson's filter box — present only when a tree was rendered. */
function jsonTree(): HTMLElement | null {
  return screen.queryByLabelText("Filter JSON content");
}

/** Markdown puts the whole message in one paragraph; a tree never does. */
function paragraphWith(text: string): boolean {
  return Array.from(document.querySelectorAll("p")).some((p) =>
    p.textContent?.includes(text),
  );
}

describe("ConversationTranscript message content", () => {
  it("renders an assistant answer that is a JSON payload as a tree", () => {
    transcript([{ role: "assistant", content: structuredAnswer }]);

    expect(jsonTree()).toBeInTheDocument();
    expect(paragraphWith("exhibits_missing")).toBe(false);
  });

  it("shows every finding without a click — the answer is not reference material", () => {
    transcript([{ role: "assistant", content: structuredAnswer }]);

    // Both notes are at depth 2, which the tree's default policy would collapse.
    expect(screen.getByText(/Exhibits are incorporated/)).toBeInTheDocument();
    expect(screen.getByText(/Transition costs are open-ended/)).toBeInTheDocument();
  });

  it("shows long string values whole — the substance lives in exactly those", () => {
    transcript([{ role: "assistant", content: structuredAnswer }]);

    // The default policy elides a string past 120 chars and marks the rest.
    expect(screen.getByText(new RegExp(LONG_FINDING.slice(-40)))).toBeInTheDocument();
    expect(screen.queryByText(/\(\d+ chars\)/)).toBeNull();
  });

  it("renders a prose answer as markdown", () => {
    transcript([
      { role: "assistant", content: "## Findings\n\nThe term is **five** years." },
    ]);

    expect(jsonTree()).toBeNull();
    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.getByText("five").tagName).toBe("STRONG");
  });

  it("renders a user message that is a JSON payload as a tree", () => {
    transcript([{ role: "user", content: '{"task":"review","paragraphs":"116-190"}' }]);

    expect(jsonTree()).toBeInTheDocument();
    expect(paragraphWith("paragraphs")).toBe(false);
  });
});
