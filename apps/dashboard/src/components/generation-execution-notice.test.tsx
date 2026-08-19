import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import GenerationExecutionNotice from "./generation-execution-notice";

describe("GenerationExecutionNotice", () => {
  it("explains a suppressed verdict and partial usage totals", () => {
    render(
      <GenerationExecutionNotice
        execution={{
          total: 22,
          errored: 17,
          error_finish_reasons: { error: 17 },
        }}
        verdictSuppressed
      />,
    );

    expect(screen.getByText(/17 of 22 generations ended in error/i)).toBeTruthy();
    expect(screen.getByText(/no pass\/fail verdict/i)).toBeTruthy();
    expect(screen.getByText(/cost and token totals are partial/i)).toBeTruthy();
    expect(screen.getByText(/error ×17/i)).toBeTruthy();
  });

  it("renders nothing when no generation errors were recorded", () => {
    const { container } = render(
      <GenerationExecutionNotice
        execution={{ total: 4, errored: 0, error_finish_reasons: {} }}
        verdictSuppressed={false}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
