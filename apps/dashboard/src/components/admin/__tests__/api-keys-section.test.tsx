/**
 * Issue #73: on initial load the API Keys section must use the first
 * accessible project when the user has not explicitly picked one. The
 * previous code used ``selectedProject ?? projects[0]?.id`` — but
 * ``selectedProject`` starts as ``""`` (not nullish), so ``??`` never fell
 * back and keys never loaded until a project was manually chosen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";

vi.mock("@/lib/api-keys-api", () => ({
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
}));

vi.mock("@/lib/projects-api", () => ({
  listProjects: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { listApiKeys } from "@/lib/api-keys-api";
import { listProjects } from "@/lib/projects-api";
import { ApiKeysSection } from "@/components/admin/api-keys-section";

beforeEach(() => {
  vi.mocked(listApiKeys).mockReset();
  vi.mocked(listApiKeys).mockResolvedValue([]);
  vi.mocked(listProjects).mockReset();
});

describe("ApiKeysSection project fallback (issue #73)", () => {
  it("uses the first accessible project on initial load when none is selected", async () => {
    vi.mocked(listProjects).mockResolvedValue([
      { id: "proj-a", name: "Alpha", created_by: "u", created_at: null, current_user_role: "admin" },
      { id: "proj-b", name: "Beta", created_by: "u", created_at: null, current_user_role: "admin" },
    ]);

    render(<ApiKeysSection />);

    await waitFor(() => {
      expect(listApiKeys).toHaveBeenCalledWith("proj-a");
    });
  });
});
