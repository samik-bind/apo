"use client"

import { useState } from "react"
import type { CreateProjectInvitationResponse } from "@/lib/project-invitations-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Copy, MailCheck, MailWarning } from "lucide-react"

export function CopyLinkCallout({
  response,
  onClose,
}: {
  response: CreateProjectInvitationResponse
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const url = response.invite_url

  async function handleCopy() {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard may be unavailable; the user can still select + copy
    }
  }

  return (
    <div className="mt-2 border border-border bg-muted/40 p-2.5">
      <div className="mb-2 flex items-start gap-2 text-xs text-muted-foreground">
        <MailWarning className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Email delivery isn&rsquo;t configured. Copy this link and send it to{" "}
          <span className="font-medium text-foreground">{response.invitation.email}</span>.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={url ?? ""}
          className="h-8 bg-card font-mono text-[11px]"
          onFocus={(e: React.FocusEvent<HTMLInputElement>) => e.target.select()}
          aria-label="Invitation link"
        />
        <Button type="button" size="sm" variant="outline" onClick={handleCopy} className="h-8">
          {copied ? <MailCheck className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} className="h-8">
          Dismiss
        </Button>
      </div>
    </div>
  )
}
