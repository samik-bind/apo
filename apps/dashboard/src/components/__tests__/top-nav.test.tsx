/**
 * TopNav identity: the logged-in user must be visible at the top of every
 * standard page (the avatar opens the account menu). Follow-up: users
 * could not tell they were logged in on run pages.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const useSessionMock = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: (...args: unknown[]) => useSessionMock(...args),
}));

const pathnameMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => pathnameMock(),
}));

import { TopNav } from "@/components/top-nav";

function sessionOf(email: string) {
  return {
    data: { user: { email, id: "u1", name: "Test" }, expires: "2099-01-01" },
    status: "authenticated" as const,
  };
}

describe("TopNav user identity", () => {
  it("shows the avatar with the email initial when authenticated", () => {
    pathnameMock.mockReturnValue("/project/demo/runs/task/run_1");
    useSessionMock.mockReturnValue(sessionOf("admin@test.com"));
    render(<TopNav />);
    const menu = screen.getByRole("button", { name: "User menu" });
    expect(menu.textContent).toBe("A");
  });

  it("shows no avatar while the session is loading or absent", () => {
    pathnameMock.mockReturnValue("/project/demo/runs");
    useSessionMock.mockReturnValue({ data: null, status: "loading" });
    const { rerender } = render(<TopNav />);
    expect(screen.queryByRole("button", { name: "User menu" })).toBeNull();
    useSessionMock.mockReturnValue({ data: null, status: "unauthenticated" });
    rerender(<TopNav />);
    expect(screen.queryByRole("button", { name: "User menu" })).toBeNull();
  });

  it("hides the whole nav on auth routes", () => {
    pathnameMock.mockReturnValue("/login");
    useSessionMock.mockReturnValue(sessionOf("admin@test.com"));
    const { container } = render(<TopNav />);
    expect(container.firstChild).toBeNull();
  });
});
