/**
 * After a successful credentials sign-in the browser must stay on the
 * origin it opened (localhost, tunnel domain). NextAuth's returned `url`
 * is absolutized against NEXTAUTH_URL / APO_PUBLIC_URL — pushing it would
 * bounce a localhost login to the public domain.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { pushMock, signInMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  signInMock: vi.fn(),
}));

vi.mock("next-auth/react", () => ({
  signIn: signInMock,
  useSession: vi.fn().mockReturnValue({
    data: undefined,
    status: "unauthenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn().mockReturnValue({ push: pushMock }),
  useSearchParams: vi
    .fn()
    .mockReturnValue({ get: (key: string) => (key === "callbackUrl" ? "/project/abc/tasks" : null) }),
}));

vi.mock("@/lib/backend-fetch", () => ({
  backendFetch: vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({}),
  }),
}));

import { LoginPage } from "../login-form";

async function submitCredentialsForm() {
  render(
    <LoginPage
      hasUsers={true}
      setupAvailable={false}
      devSignin={{ enabled: false, landingPath: "/" }}
    />,
  );

  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "admin@test.com" },
  });
  fireEvent.change(screen.getByLabelText(/password/i), {
    target: { value: "Admin123" },
  });
  fireEvent.submit(screen.getByLabelText(/email/i).closest("form")!);
}

describe("login redirect origin", () => {
  it("navigates to the relative callbackUrl, not NextAuth's absolutized url", async () => {
    signInMock.mockResolvedValue({
      error: null,
      ok: true,
      status: 200,
      url: "https://test-apo.online/project/abc/tasks",
    });

    await submitCredentialsForm();

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith("/project/abc/tasks");
  });

  it("still redirects on success even when signIn returns no url", async () => {
    signInMock.mockResolvedValue({ error: null, ok: true, status: 200 });

    await submitCredentialsForm();

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith("/project/abc/tasks");
  });
});
