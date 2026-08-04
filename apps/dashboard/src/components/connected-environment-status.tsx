import { cn } from "@/lib/utils";
import type { ConnectedEnvironmentState } from "@/lib/executor-api";

interface ConnectedEnvironmentStatusProps {
  state: ConnectedEnvironmentState;
  className?: string;
}

const STATE_LABEL: Record<ConnectedEnvironmentState, string> = {
  ready: "Connected",
  busy: "Busy",
  offline: "Offline",
  not_connected: "Not connected",
  incompatible: "Incompatible",
  catalog_mismatch: "Catalog mismatch",
};

const STATE_DOT: Record<ConnectedEnvironmentState, string> = {
  ready: "bg-success",
  busy: "bg-foreground animate-pulse",
  offline: "bg-muted-foreground animate-pulse",
  not_connected: "bg-muted-foreground",
  incompatible: "bg-warning",
  catalog_mismatch: "bg-warning",
};

const STATE_TOOLTIP: Record<ConnectedEnvironmentState, string> = {
  ready: "Your connected environment is ready",
  busy: "Your connected environment is busy — runs will queue",
  offline: "Waiting for apo connect",
  not_connected: "Run apo connect in this Task workspace",
  incompatible: "Update the Apo CLI, then restart apo connect",
  catalog_mismatch: "Run apo task publish from this Task workspace",
};

/** Compact status indicator for the Tasks page toolbar.
 * Just a dot + one word. Full guidance is on hover (title). */
export function ConnectedEnvironmentStatusView({
  state,
  className,
}: ConnectedEnvironmentStatusProps) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-[12px] text-muted-foreground", className)}
      title={STATE_TOOLTIP[state]}
    >
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATE_DOT[state])}
        aria-hidden
      />
      <span>{STATE_LABEL[state]}</span>
    </span>
  );
}
