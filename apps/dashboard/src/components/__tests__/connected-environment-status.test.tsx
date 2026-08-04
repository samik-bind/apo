import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectedEnvironmentStatusView } from "@/components/connected-environment-status";

describe("ConnectedEnvironmentStatusView (SPEC-162)", () => {
  const cases: Array<{
    state: Parameters<typeof ConnectedEnvironmentStatusView>[0]["state"];
    label: string;
    tooltip: string;
  }> = [
    { state: "ready", label: "Connected", tooltip: "Your connected environment is ready" },
    { state: "busy", label: "Busy", tooltip: "Your connected environment is busy" },
    { state: "offline", label: "Offline", tooltip: "Waiting for apo connect" },
    { state: "not_connected", label: "Not connected", tooltip: "Run apo connect" },
    { state: "incompatible", label: "Incompatible", tooltip: "Update the Apo CLI" },
    { state: "catalog_mismatch", label: "Catalog mismatch", tooltip: "apo task publish" },
  ];

  it.each(cases)("renders compact label '$label' for state $state", ({ state, label }) => {
    render(<ConnectedEnvironmentStatusView state={state} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each(cases)("puts full guidance in the tooltip for state $state", ({ state, tooltip, label }) => {
    render(<ConnectedEnvironmentStatusView state={state} />);
    const el = screen.getByText(label);
    expect(el.closest("[title]")?.getAttribute("title")).toContain(tooltip);
  });

  it("renders a status dot", () => {
    const { container } = render(<ConnectedEnvironmentStatusView state="ready" />);
    const dot = container.querySelector(".bg-success");
    expect(dot).toBeTruthy();
  });
});
