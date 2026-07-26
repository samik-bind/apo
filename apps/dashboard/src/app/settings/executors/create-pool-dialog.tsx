"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface CreatePoolDialogProps {
  busy: boolean;
  onClose: () => void;
  onCreate: (body: {
    name: string;
    slug: string;
    queue_ttl_seconds: number;
  }) => void;
}

export function CreatePoolDialog({
  busy,
  onClose,
  onCreate,
}: CreatePoolDialogProps) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create Connected Pool</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="pool-name" className="text-xs font-medium">Name</label>
            <Input
              id="pool-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setSlug(slugify(event.target.value));
              }}
              placeholder="Production VPC"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="pool-slug" className="text-xs font-medium">Slug</label>
            <Input
              id="pool-slug"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              className="font-mono"
              placeholder="production-vpc"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            type="button"
            disabled={busy || !name.trim() || !slug}
            onClick={() => onCreate({
              name: name.trim(),
              slug,
              queue_ttl_seconds: 86_400,
            })}
          >
            Create Pool
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 63);
}
