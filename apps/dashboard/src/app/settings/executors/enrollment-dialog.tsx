"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import type { EnrollmentTokenResponse } from "@/lib/executor-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function EnrollmentDialog({
  enrollment,
  busy,
  onClose,
  onRevoke,
}: {
  enrollment: EnrollmentTokenResponse;
  busy: boolean;
  onClose: () => void;
  onRevoke: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const command = buildDockerCommand(enrollment);

  async function copyCommand() {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Connect an Executor</DialogTitle>
          <DialogDescription>
            This enrollment token is shown once and expires{" "}
            {new Date(enrollment.expires_at).toLocaleString()}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-[12px] text-warning">
            Copy the command before closing. Apo cannot recover this raw token.
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border border-border bg-muted/30 p-3 font-mono text-[11px]">
            {command}
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={copyCommand}
            aria-label="Copy Executor Docker command"
          >
            {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy Docker command"}
          </Button>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onRevoke}
            className="text-destructive"
          >
            Revoke unused token
          </Button>
          <Button type="button" disabled={busy} onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildDockerCommand(enrollment: EnrollmentTokenResponse): string {
  const environment = Object.entries(enrollment.container.environment)
    .map(([name, value]) => `-e ${name}=${shellQuote(value)}`)
    .join(" \\\n  ");
  const command = enrollment.container.command.map(shellQuote).join(" ");
  return [
    "docker run -d --name apo-executor \\",
    `  -v apo-executor-state:${enrollment.container.state_volume} \\`,
    `  ${environment} \\`,
    `  ${shellQuote(enrollment.container.image)} ${command}`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
