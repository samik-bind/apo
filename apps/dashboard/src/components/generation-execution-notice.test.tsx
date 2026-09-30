import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import GenerationExecutionNotice from "./generation-execution-notice";

const minority = { total: 4, errored: 1, error_finish_reasons: {} };
const dominated = { total: 4, errored: 3, error_finish_reasons: {} };

describe("GenerationExecutionNotice", () => {
  it("explains a suppressed verdict and partial usage totals", () => {
    render(
      <GenerationExecutionNotice
        execution={{
          total: 22,
          errored: 17,
          error_finish_reasons: { error: 17 },
        }}
        verdict="withheld"
      />,
    );

    expect(screen.getByText(/17 of 22 generations ended in error/i)).toBeTruthy();
    expect(screen.getByText(/no pass\/fail verdict/i)).toBeTruthy();
    expect(screen.getByText(/cost and token totals are partial/i)).toBeTruthy();
    expect(screen.getByText(/error ×17/i)).toBeTruthy();
  });

  it("says the verdict was kept only when the run has one", () => {
    render(<GenerationExecutionNotice execution={minority} verdict="kept" />);
    expect(screen.getByText(/kept its verdict/i)).toBeTruthy();
  });

  it("a judge no-verdict run: too few errors to withhold the verdict on their own (#323)", () => {
    render(<GenerationExecutionNotice execution={minority} verdict="judge-no-verdict" />);
    expect(screen.queryByText(/kept its verdict/i)).toBeNull();
    expect(screen.getByText(/too few to withhold the verdict/i)).toBeTruthy();
  });

  it("an execution error never claims the errors were too few to matter", () => {
    render(<GenerationExecutionNotice execution={minority} verdict="execution-error" />);
    expect(screen.queryByText(/too few to withhold/i)).toBeNull();
    expect(screen.queryByText(/kept its verdict/i)).toBeNull();
    expect(screen.getByText(/the run ended in an execution error/i)).toBeTruthy();
  });

  it("an execution error beside dominating generation errors says they dominated", () => {
    render(<GenerationExecutionNotice execution={dominated} verdict="execution-error" />);
    expect(screen.queryByText(/too few to withhold/i)).toBeNull();
    expect(screen.getByText(/most generations errored/i)).toBeTruthy();
  });

  it("renders nothing when no generation errors were recorded", () => {
    const { container } = render(
      <GenerationExecutionNotice
        execution={{ total: 4, errored: 0, error_finish_reasons: {} }}
        verdict="kept"
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
