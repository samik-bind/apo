/**
 * SPEC-180: the first-run panel renders the exact hosted setup — public
 * URL only, never internal/localhost — and disappears once the Project
 * has published Tasks or recorded Runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProjectFirstRun } from "../ProjectFirstRun";

const setup = (overrides: Partial<Parameters<typeof ProjectFirstRun>[0]["setup"]> = {}) => ({
  publicUrl: "https://test-apo.online",
  projectId: "abc123def456",
  cliLoginCommand:
    "apo login --backend https://test-apo.online --project abc123def456",
  docsUrl: "/docs/hosted-alpha",
  exampleUrl:
    "https://github.com/samikuikka/apo/tree/main/apps/example-service/e2e/agent-task-demo",
  ...overrides,
});

describe("ProjectFirstRun (SPEC-180)", () => {
  const clipboardWrite = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    clipboardWrite.mockClear();
    // userEvent.setup() may install its own clipboard stub, so tests
    // assert against this captured mock rather than navigator.clipboard.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWrite },
      configurable: true,
    });
  });

  it("renders the four stages with the exact login command", () => {
    render(<ProjectFirstRun setup={setup()} />);

    expect(screen.getByText(/install the cli/i)).toBeDefined();
    expect(screen.getByText(/connect this project/i)).toBeDefined();
    expect(screen.getByText(/choose a task source/i)).toBeDefined();
    expect(screen.getByText(/publish and run locally/i)).toBeDefined();
    expect(
      screen.getByText(
        "apo login --backend https://test-apo.online --project abc123def456",
      ),
    ).toBeDefined();
    expect(screen.getByText(/npm install -g @apo-ai\/cli/)).toBeDefined();
  });

  it("uses the public URL and never an internal URL", () => {
    render(<ProjectFirstRun setup={setup()} />);

    const text = document.body.textContent ?? "";
    expect(text).toContain("https://test-apo.online");
    expect(text).not.toContain("http://backend:8000");
    expect(text).not.toContain("localhost:8000");
  });

  it("fails honestly on an invalid public URL with no localhost fallback", () => {
    render(<ProjectFirstRun setup={setup({ publicUrl: "", cliLoginCommand: "" })} />);

    expect(screen.getByText(/installation is misconfigured/i)).toBeDefined();
    expect(screen.getByText(/APO_PUBLIC_URL/i)).toBeDefined();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("localhost");
    expect(screen.queryByText(/apo login/)).toBeNull();
  });

  it("labels placeholders as replacements, not runnable commands", () => {
    render(<ProjectFirstRun setup={setup()} />);

    expect(screen.getAllByText(/replace this/i).length).toBeGreaterThan(0);
    // <task-id> appears as an explicit placeholder
    expect(screen.getAllByText(/<task-id>/).length).toBeGreaterThan(0);
  });

  it("presents own-agent and maintained-example paths", () => {
    render(<ProjectFirstRun setup={setup()} />);

    expect(screen.getByText(/use apo in my (own )?agent/i)).toBeDefined();
    expect(screen.getByText(/maintained example/i)).toBeDefined();
  });

  it("copy controls copy the exact command", () => {
    render(<ProjectFirstRun setup={setup()} />);

    // fireEvent instead of userEvent: userEvent.setup() installs its own
    // clipboard stub, which would swallow the call under assertion.
    fireEvent.click(
      screen.getByRole("button", { name: /copy login command/i }),
    );

    expect(clipboardWrite).toHaveBeenCalledWith(
      "apo login --backend https://test-apo.online --project abc123def456",
    );
  });

  it("explains that PASS and FAIL both record useful evidence", () => {
    render(<ProjectFirstRun setup={setup()} />);

    expect(
      screen.getByText(/pass and fail are both useful recorded outcomes/i),
    ).toBeDefined();
  });

  it("notes that provider credentials stay local", () => {
    render(<ProjectFirstRun setup={setup()} />);

    expect(screen.getByText(/stay on your machine/i)).toBeDefined();
  });
});
