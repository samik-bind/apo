"use client"

import { useCallback, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Loader2 } from "lucide-react"
import {
  type ApiKeyScope,
  createApiKey,
} from "@/lib/api-keys-api"
import type { Project } from "@/lib/projects-api"
import { toast } from "sonner"
import type { ApiKeyRevealPayload } from "@/components/api-key-created-dialog"

interface ApiKeyCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultProject?: string
  /** Accessible projects to choose from (issue #73). */
  projects?: Project[]
  onCreated: (payload: ApiKeyRevealPayload) => void
}

export function ApiKeyCreateDialog({
  open,
  onOpenChange,
  defaultProject,
  projects = [],
  onCreated,
}: ApiKeyCreateDialogProps) {
  // Issue #73: pick a real Project ID from the user's accessible projects
  // rather than a free-text value. Fall back to the first project when the
  // parent has no current selection, and to "" (disabled) when none exist.
  const initialProject = defaultProject ?? projects[0]?.id ?? ""
  const [name, setName] = useState("")
  const [project, setProject] = useState(initialProject)
  // SPEC-149: default to the least-privileged scope. Telemetry producer
  // issuance is the common case; full management access is an explicit
  // administrative choice.
  const [scope, setScope] = useState<ApiKeyScope>("ingest")
  const [expiresAt, setExpiresAt] = useState("")
  const [creating, setCreating] = useState(false)

  const hasProjects = projects.length > 0

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) {
      setName("")
      setProject(defaultProject ?? projects[0]?.id ?? "")
      setScope("ingest")
      setExpiresAt("")
    }
    onOpenChange(next)
  }, [defaultProject, projects, onOpenChange])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!hasProjects || !project) return
    setCreating(true)
    try {
      const result = await createApiKey(
        name.trim() || "Default",
        project,
        scope,
        expiresAt ? new Date(expiresAt).toISOString() : undefined,
      )
      onCreated(result)
      onOpenChange(false)
      toast.success("API key created")
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create API key")
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            Generate a key pair for the SDK or CLI to authenticate against the backend.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-project">Project</Label>
            <select
              id="api-key-project"
              aria-label="Project"
              value={project}
              onChange={(e) => setProject(e.target.value)}
              disabled={!hasProjects}
              className="h-8 w-full min-w-0 rounded-none border border-input bg-input/30 px-2.5 py-1 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {!hasProjects && <option value="">No eligible projects</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-scope">Scope</Label>
            <select
              id="api-key-scope"
              aria-label="Scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as ApiKeyScope)}
              className="h-8 w-full min-w-0 rounded-none border border-input bg-input/30 px-2.5 py-1 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              <option value="ingest">Ingest only — recommended for telemetry producers</option>
              <option value="full">Full access — CLI and management</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="api-key-expires">Expires (optional)</Label>
            <Input
              id="api-key-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>

          <DialogFooter className="sm:col-span-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={creating || !hasProjects}>
              {creating && <Loader2 className="size-4 animate-spin" />}
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
