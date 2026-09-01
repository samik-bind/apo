"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Check, Copy, MoreVertical, Pause, Pencil, Play, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { ApiKey } from "@/lib/api-keys-api"
import { patchApiKey } from "@/lib/api-keys-api"
import { formatRelativeTime } from "@/lib/format"

interface ApiKeyRowProps {
  apiKey: ApiKey
  onRotate: (id: string) => void
  onRevoke: (id: string) => void
  onGuardrailsChanged?: () => void
}

export function ApiKeyRow({ apiKey, onRotate, onRevoke, onGuardrailsChanged }: ApiKeyRowProps) {
  const [copied, setCopied] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [quotaOpen, setQuotaOpen] = useState(false)
  const [quotaInput, setQuotaInput] = useState(
    apiKey.dailySpanQuota != null ? String(apiKey.dailySpanQuota) : "",
  )
  const [busy, setBusy] = useState(false)

  async function applyPatch(patch: { dailySpanQuota?: number | null; ingestPaused?: boolean }) {
    setBusy(true)
    try {
      await patchApiKey(apiKey.id, patch)
      toast.success(patch.ingestPaused !== undefined
        ? patch.ingestPaused ? "Ingest paused for this key" : "Ingest resumed"
        : "Quota updated")
      onGuardrailsChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Update failed")
    } finally {
      setBusy(false)
    }
  }

  function submitQuota() {
    const trimmed = quotaInput.trim()
    const value = trimmed === "" ? null : Number(trimmed)
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast.error("Quota must be a non-negative number (empty = unlimited)")
      return
    }
    setQuotaOpen(false)
    void applyPatch({ dailySpanQuota: value })
  }

  const quota = apiKey.dailySpanQuota
  const used = apiKey.todayUsage?.spans ?? 0
  const pct = quota && quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : null

  const expires = apiKey.expires_at ? new Date(apiKey.expires_at) : null
  const isExpired = expires ? expires < new Date() : false

  function copyIdentifier() {
    const id = apiKey.publicKey ?? apiKey.prefix
    navigator.clipboard.writeText(id)
    setCopied(true)
    toast.success("Copied to clipboard")
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <li className="group flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{apiKey.name}</span>
          <Badge variant="secondary" className="capitalize">{apiKey.scope}</Badge>
          {isExpired && <Badge variant="destructive">Expired</Badge>}
          {apiKey.ingestPaused && <Badge variant="destructive">Ingest paused</Badge>}
          <Badge variant={quota ? "outline" : "secondary"} title="Quota is per key — N keys = N × cap">
            {quota ? `${Intl.NumberFormat("en", { notation: "compact" }).format(quota)} spans/day` : "no quota"}
          </Badge>
        </div>

        {quota != null && quota > 0 && (
          <div className="mt-2 max-w-56">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={pct !== null && pct >= 100 ? "h-full bg-destructive" : pct !== null && pct >= 80 ? "h-full bg-amber-500" : "h-full bg-primary"}
                style={{ width: `${pct ?? 0}%` }}
              />
            </div>
            <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
              <span>{used.toLocaleString()} today</span>
              <span>{quota.toLocaleString()}</span>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={copyIdentifier}
          className="mt-1.5 inline-flex max-w-full items-center gap-1.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
          title={apiKey.publicKey ? "Copy public key" : "Copy key prefix"}
        >
          <code className="truncate">
            {apiKey.publicKey
              ? apiKey.publicKey
              : `${apiKey.prefix}••••`}
          </code>
          {apiKey.displaySecretKey && (
            <code className="truncate text-muted-foreground/60">
              {apiKey.displaySecretKey}
            </code>
          )}
          {copied ? (
            <Check className="size-3 shrink-0 text-success" />
          ) : (
            <Copy className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </button>

        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground/70">
          <span className="font-medium text-muted-foreground">{apiKey.project}</span>
          <span aria-hidden>·</span>
          <span>created {formatRelativeTime(apiKey.created_at)}</span>
          {apiKey.last_used_at && (
            <>
              <span aria-hidden>·</span>
              <span>last used {formatRelativeTime(apiKey.last_used_at)}</span>
            </>
          )}
          {expires && !isExpired && (
            <>
              <span aria-hidden>·</span>
              <span>expires {expires.toLocaleDateString("en-US", { timeZone: "UTC" })}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="opacity-60 transition-opacity group-hover:opacity-100"
              aria-label={`Actions for ${apiKey.name}`}
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{apiKey.name}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={copyIdentifier}>
              <Copy className="size-4" />
              Copy identifier
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setRotateOpen(true)}>
              <RefreshCw className="size-4" />
              Rotate key
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => void applyPatch({ ingestPaused: !apiKey.ingestPaused })}
            >
              {apiKey.ingestPaused ? <Play className="size-4" /> : <Pause className="size-4" />}
              {apiKey.ingestPaused ? "Resume ingest" : "Pause ingest"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { setQuotaInput(apiKey.dailySpanQuota != null ? String(apiKey.dailySpanQuota) : ""); setQuotaOpen(true) }}>
              <Pencil className="size-4" />
              Edit daily quota
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setRevokeOpen(true)}>
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rotate this key?</AlertDialogTitle>
            <AlertDialogDescription>
              A new key pair will be generated and the current one will stop working immediately.
              You&apos;ll be shown the new secret once — copy it before closing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="default" onClick={() => onRotate(apiKey.id)}>
              Rotate key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this key?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <span className="font-medium text-foreground">{apiKey.name}</span> and
              cannot be undone. Any service using it will stop authenticating immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => onRevoke(apiKey.id)}>
              Delete key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={quotaOpen} onOpenChange={setQuotaOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Daily span quota for {apiKey.name}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <span>
                  Maximum accepted spans per UTC day for THIS key (per key — N keys = N × cap).
                  Over-quota requests get 429 until UTC midnight. Empty = unlimited.
                </span>
                <div className="space-y-1.5">
                  <Label htmlFor={`quota-${apiKey.id}`}>Spans per day</Label>
                  <Input
                    id={`quota-${apiKey.id}`}
                    inputMode="numeric"
                    placeholder="unlimited"
                    value={quotaInput}
                    onChange={(e) => setQuotaInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitQuota() } }}
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={submitQuota}>Save quota</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </li>
  )
}
