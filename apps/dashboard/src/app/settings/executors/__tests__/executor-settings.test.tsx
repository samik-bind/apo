import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EnrollmentTokenResponse,
  ExecutorPoolSummary,
} from "@/lib/executor-api";
import { EnrollmentDialog } from "../enrollment-dialog";
import { PoolList } from "../pool-list";

const POOL: ExecutorPoolSummary = {
  id: "pool-private",
  name: "Private VPC",
  slug: "private-vpc",
  kind: "connected",
  enabled: true,
  archived: false,
  is_default: false,
  health: "online",
  online_executor_count: 1,
  available_capacity: 2,
  queue_ttl_seconds: 86_400,
  required_driver_kind: "subprocess",
};

const ENROLLMENT: EnrollmentTokenResponse = {
  id: "token-1",
  pool_id: "pool-private",
  token: "apo_enroll_secret-once",
  expires_at: "2026-07-26T12:15:00Z",
  container: {
    image: "ghcr.io/samikuikka/apo-backend:0.2.0",
    command: ["python", "-m", "apo.executor", "connect"],
    environment: {
      APO_CONTROL_PLANE_URL: "https://apo.example",
      APO_EXECUTOR_ENROLLMENT_TOKEN: "apo_enroll_secret-once",
      APO_EXECUTOR_NAME: "private-vpc-1",
    },
    state_volume: "/var/lib/apo-executor",
  },
};

describe("Executor settings", () => {
  it("keeps Pool mutations hidden from Project members", () => {
    renderPoolList({ canManage: false, canArchive: false });
    expect(screen.getByText("Private VPC")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create token" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("shows admin controls without exposing owner-only archive", () => {
    renderPoolList({ canManage: true, canArchive: false });
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create token" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("renders and copies the exact version-pinned enrollment command once", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const persist = vi.spyOn(Storage.prototype, "setItem");

    const revoke = vi.fn();
    render(
      <EnrollmentDialog
        enrollment={ENROLLMENT}
        busy={false}
        onClose={vi.fn()}
        onRevoke={revoke}
      />,
    );
    expect(screen.getByText(/apo-backend:0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByText(/apo_enroll_secret-once/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", {
      name: "Copy Executor Docker command",
    }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(
      "ghcr.io/samikuikka/apo-backend:0.2.0",
    ));
    expect(persist).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", {
      name: "Revoke unused token",
    }));
    expect(revoke).toHaveBeenCalledOnce();
    persist.mockRestore();
  });
});

function renderPoolList({
  canManage,
  canArchive,
}: {
  canManage: boolean;
  canArchive: boolean;
}) {
  return render(
    <PoolList
      pools={[POOL]}
      selectedPoolId={POOL.id}
      canManage={canManage}
      canArchive={canArchive}
      busy={false}
      onSelect={vi.fn()}
      onSetDefault={vi.fn()}
      onCreateToken={vi.fn()}
      onEdit={vi.fn()}
      onToggle={vi.fn()}
      onArchive={vi.fn()}
    />,
  );
}
