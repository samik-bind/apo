"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { cancelAgentTaskBatchRun } from "@/lib/agent-task-api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface BatchRunCancelButtonProps {
  batchRunId: string;
  /** Disables the action when the Batch is already terminal. */
  disabled?: boolean;
}

/** SPEC-162: client cancellation action for the server-rendered Batch detail.
 *
 * Idempotent: the second click while the request is in flight is suppressed
 * and the button renders a disabled "Cancelling…" state. The underlying
 * route is itself idempotent, so a retry after a transient failure is safe.
 */
export function BatchRunCancelButton({
  batchRunId,
  disabled,
}: BatchRunCancelButtonProps) {
  const [cancelling, setCancelling] = useState(false);

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await cancelAgentTaskBatchRun(batchRunId);
      toast.success("Run cancelling");
      // The page auto-refreshes while running; the cancelled state appears
      // on the next poll once the cancellation propagates.
    } catch (e: unknown) {
      toast.error(
        e instanceof Error
          ? `Cancel failed: ${e.message}`
          : "Cancel failed — try again",
      );
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 text-[13px] font-normal"
      onClick={handleCancel}
      disabled={cancelling || disabled}
      aria-busy={cancelling}
    >
      <X className="h-3.5 w-3.5" />
      {cancelling ? "Cancelling…" : "Cancel Run"}
    </Button>
  );
}
