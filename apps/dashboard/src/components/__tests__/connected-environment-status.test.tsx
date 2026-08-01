import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectedEnvironmentStatusView } from "@/components/connected-environment-status";

describe("ConnectedEnvironmentStatusView copy", () => {
  const cases: Array<{
    state: Parameters<typeof ConnectedEnvironmentStatusView>[0]["state"];
    expected: RegExp;
  }> = [
    { state: "ready", expected: /Your connected environment is ready/i },
    { state: "busy", expected: /Your connected environment is busy — this run will wait/i },
    { state: "offline", expected: /Waiting for apo connect/i },
    { state: "not_connected", expected: /Run apo connect in this Task workspace/i },
    { state: "incompatible", expected: /Update the Apo CLI, then restart apo connect/i },
    { state: "catalog_mismatch", expected: /Run apo task publish from this Task workspace/i },
  ];

  it.each(cases)("renders actionable primary copy for $state", ({ state, expected }) => {
    render(<ConnectedEnvironmentStatusView state={state} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("renders the corrective guidance for an incompatible state", () => {
    render(<ConnectedEnvironmentStatusView state="incompatible" />);
    expect(screen.getByText(/Queued work will start when compatible/i)).toBeInTheDocument();
  });

  it("renders no guidance when ready", () => {
    const { container } = render(<ConnectedEnvironmentStatusView state="ready" />);
    expect(container.textContent).toMatch(/Your connected environment is ready/i);
    expect(container.textContent).not.toMatch(/·/);
  });
});
