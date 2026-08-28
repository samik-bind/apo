/**
 * The administrator Hosted access page lists invitations,
 * issues new ones with the one-time copy-link fallback, resends, and
 * revokes. Non-administrators never render the controls (server gate).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/hosted-access-api", () => ({
  listHostedAccessInvitations: vi.fn(),
  createHostedAccessInvitation: vi.fn(),
  resendHostedAccessInvitation: vi.fn(),
  revokeHostedAccessInvitation: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

import {
  createHostedAccessInvitation,
  resendHostedAccessInvitation,
  revokeHostedAccessInvitation,
  type HostedAccessInvitationSummary,
} from "@/lib/hosted-access-api";
import { auth } from "@/auth";
import { HostedAccessAdmin } from "../hosted-access-admin";
import HostedAccessSettingsPage from "@/app/settings/hosted-access/page";

function invitation(
  overrides: Partial<HostedAccessInvitationSummary> = {},
): HostedAccessInvitationSummary {
  return {
    id: "inv-1",
    email: "friend@example.com",
    delivery_method: "link_only",
    expires_at: "2099-01-01T00:00:00Z",
    created_at: "2026-08-15T00:00:00Z",
    invited_by_user_id: "admin-1",
    accepted_at: null,
    accepted_by_user_id: null,
    accepted_project_id: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(createHostedAccessInvitation).mockReset();
  vi.mocked(resendHostedAccessInvitation).mockReset();
  vi.mocked(revokeHostedAccessInvitation).mockReset();
});

describe("HostedAccessAdmin", () => {
  it("lists invitations from the server prefetch", () => {
    render(
      <HostedAccessAdmin initialInvitations={[invitation()]} />,
    );

    expect(screen.getByText("friend@example.com")).toBeDefined();
    expect(screen.getByRole("button", { name: /resend/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeDefined();
  });

  it("creates an invitation and reveals the one-time link fallback", async () => {
    vi.mocked(createHostedAccessInvitation).mockResolvedValue({
      invitation: invitation({ email: "new@example.com", id: "inv-2" }),
      invite_url: "http://localhost:3000/join?token=raw-abc",
      delivery_status: "link_only",
    });

    render(<HostedAccessAdmin initialInvitations={[]} />);
    const user = userEvent.setup();

    await user.type(
      screen.getByLabelText(/invite someone/i),
      "new@example.com",
    );
    await user.click(screen.getByRole("button", { name: /send invitation/i }));

    await waitFor(() => {
      expect(createHostedAccessInvitation).toHaveBeenCalledWith(
        "new@example.com",
      );
    });
    expect(
      await screen.findByText(/will not be shown again/i),
    ).toBeDefined();
    expect(screen.getByText(/raw-abc/)).toBeDefined();
  });

  it("revokes an invitation", async () => {
    vi.mocked(revokeHostedAccessInvitation).mockResolvedValue(undefined);

    render(<HostedAccessAdmin initialInvitations={[invitation()]} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      expect(revokeHostedAccessInvitation).toHaveBeenCalledWith("inv-1");
    });
  });

  it("hides actions on already-accepted invitations", () => {
    render(
      <HostedAccessAdmin
        initialInvitations={[
          invitation({
            accepted_at: "2026-08-16T00:00:00Z",
            accepted_by_user_id: "u-2",
            accepted_project_id: "proj-made",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Accepted")).toBeDefined();
    expect(screen.queryByRole("button", { name: /resend/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
  });
});

describe("HostedAccessSettingsPage admin gate", () => {
  it("renders administrator controls for an installation admin", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.com", is_admin: true },
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const ui = await HostedAccessSettingsPage();
    render(ui);

    expect(
      screen.getByLabelText(/invite someone/i),
    ).toBeDefined();
  });

  it("renders only the access-required notice for non-admins", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "u-1", email: "member@example.com", is_admin: false },
    } as unknown as Awaited<ReturnType<typeof auth>>);

    const ui = await HostedAccessSettingsPage();
    render(ui);

    expect(screen.getByText(/administrator access required/i)).toBeDefined();
    expect(screen.queryByLabelText(/invite someone/i)).toBeNull();
  });
});
