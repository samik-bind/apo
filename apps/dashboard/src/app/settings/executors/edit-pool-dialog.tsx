"use client";

import { useState } from "react";
import type { ExecutorPoolSummary } from "@/lib/executor-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function EditPoolDialog({
  pool,
  busy,
  onClose,
  onSave,
}: {
  pool: ExecutorPoolSummary;
  busy: boolean;
  onClose: () => void;
  onSave: (patch: { name: string; queue_ttl_seconds: number }) => void;
}) {
  const [name, setName] = useState(pool.name);
  const [queueTtlSeconds, setQueueTtlSeconds] = useState(pool.queue_ttl_seconds);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {pool.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="edit-pool-name" className="text-xs font-medium">
              Name
            </label>
            <Input
              id="edit-pool-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="edit-pool-ttl" className="text-xs font-medium">
              Queue timeout
            </label>
            <select
              id="edit-pool-ttl"
              value={queueTtlSeconds}
              onChange={(event) => setQueueTtlSeconds(Number(event.target.value))}
              className="flex h-8 w-full border border-input bg-transparent px-2.5 text-[12px] outline-none focus:border-ring"
            >
              <option value={3600}>1 hour</option>
              <option value={21_600}>6 hours</option>
              <option value={86_400}>24 hours</option>
              <option value={604_800}>7 days</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => onSave({
              name: name.trim(),
              queue_ttl_seconds: queueTtlSeconds,
            })}
          >
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
