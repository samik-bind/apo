"use client"

import { useCallback, useState } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * A code line with an accessible copy control.
 *
 * The command is displayed as selectable text — if the Clipboard API is
 * unavailable or fails, the user can still select and copy it manually.
 */
export function CopyCommand({
  command,
  label,
}: {
  command: string
  label: string
}) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  const handleCopy = useCallback(() => {
    const clipboard = navigator.clipboard
    if (!clipboard?.writeText) {
      setFailed(true)
      return
    }
    clipboard
      .writeText(command)
      .then(() => {
        setCopied(true)
        setFailed(false)
        setTimeout(() => setCopied(false), 2000)
      })
      .catch(() => {
        setFailed(true)
      })
  }, [command])

  return (
    <div className="space-y-1">
      <div className="flex items-stretch gap-1.5">
        <code
          className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-foreground"
          aria-label={`${label} command`}
        >
          {command}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-auto shrink-0 gap-1.5 px-2"
          onClick={handleCopy}
          aria-label={copied ? `${label} copied` : `Copy ${label} command`}
        >
          {copied ? (
            <Check className="size-3.5 text-success" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {failed && (
        <p className="text-xs text-muted-foreground">
          Copy failed — select the command text and copy it manually.
        </p>
      )}
    </div>
  )
}
