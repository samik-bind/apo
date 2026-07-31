import { cn } from "@/lib/utils";
import type { ConnectedEnvironmentState } from "@/lib/executor-api";

interface ConnectedEnvironmentStatusProps {
  state: ConnectedEnvironmentState;
  className?: string;
}

interface StatusCopy {
  primary: string;
  guidance: string | null;
}

/** SPEC-162: stable, actionable copy for each Connected Environment state.
 * Never implies Apo owns, clones, deploys, or remotely commands the Task. */
function copyForState(state: ConnectedEnvironmentState): StatusCopy {
  switch (state) {
    case "ready":
      return {
        primary: "Your connected environment is ready",
        guidance: null,
      };
    case "busy":
      return {
        primary: "Your connected environment is busy — this run will wait",
        guidance: null,
      };
    case "offline":
      return {
        primary: "Waiting for apo connect",
        guidance: "Start apo connect in this Task workspace",
      };
    case "not_connected":
      return {
        primary: "Run apo connect in this Task workspace",
        guidance: "Authenticate and connect this Project",
      };
    case "incompatible":
      return {
        primary: "Update the Apo CLI, then restart apo connect",
        guidance: "Queued work will start when compatible",
      };
    case "catalog_mismatch":
      return {
        primary: "Run apo task publish from this Task workspace",
        guidance: "Keep apo connect running; it resumes automatically",
      };
  }
}

/** Compact status copy for the Tasks page. Renders the aggregate state
 * beside the Run action without adding a second primary action. */
export function ConnectedEnvironmentStatusView({
  state,
  className,
}: ConnectedEnvironmentStatusProps) {
  const copy = copyForState(state);
  const isReady = state === "ready";
  return (
    <output
      className={cn(
        "inline-flex items-center gap-1.5 text-[12px]",
        isReady ? "text-muted-foreground" : "text-foreground/70",
        className,
      )}
      aria-live="polite"
    >
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          isReady
            ? "bg-success"
            : state === "busy"
              ? "bg-foreground animate-pulse"
              : "bg-muted-foreground animate-pulse",
        )}
        aria-hidden
      />
      <span>{copy.primary}</span>
      {copy.guidance && (
        <span className="text-muted-foreground/70">· {copy.guidance}</span>
      )}
    </output>
  );
}
