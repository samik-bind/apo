"use client";

import { useState } from "react";
import type { ExecutorSummary } from "@/lib/executor-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function RenameExecutorDialog({
  executor,
  busy,
  onClose,
  onRename,
}: {
  executor: ExecutorSummary;
  busy: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(executor.name);
  const normalizedName = name.trim();

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename Executor</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="executor-name" className="text-xs font-medium">
            Name
          </label>
          <Input
            id="executor-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !normalizedName || normalizedName === executor.name}
            onClick={() => onRename(normalizedName)}
          >
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
