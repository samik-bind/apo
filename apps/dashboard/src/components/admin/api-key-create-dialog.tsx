"use client"

import { useCallback, useReducer } from "react"
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

// Hoisted so the default prop value keeps a stable identity across renders.
const EMPTY_PROJECTS: Project[] = []

// ----------------------------------------------------------------------------
// Create-key form reducer.
//
// The form fields (name, project, scope, expiry) and the in-flight submit
// flag describe one cohesive form lifecycle, so they transition together via
// a single dispatched action instead of five parallel setter calls.
// ----------------------------------------------------------------------------

interface CreateKeyFormState {
  name: string
  project: string
  scope: ApiKeyScope
  expiresAt: string
  quota: string
  creating: boolean
}

type CreateKeyFormAction =
  | { type: "NAME_SET"; name: string }
  | { type: "PROJECT_SET"; project: string }
  | { type: "SCOPE_SET"; scope: ApiKeyScope }
  | { type: "EXPIRES_AT_SET"; expiresAt: string }
  | { type: "QUOTA_SET"; quota: string }
  | { type: "RESET"; project: string }
  | { type: "CREATING_SET"; creating: boolean }

function createInitialFormState(project: string): CreateKeyFormState {
  return {
    name: "",
    project,
    // default to the least-privileged scope. Telemetry producer
    // issuance is the common case; full management access is an explicit
    // administrative choice.
    scope: "ingest",
    expiresAt: "",
    quota: "",
    creating: false,
  }
}

function createKeyFormReducer(
  state: CreateKeyFormState,
  action: CreateKeyFormAction,
): CreateKeyFormState {
  switch (action.type) {
    case "NAME_SET":
      return { ...state, name: action.name }
    case "PROJECT_SET":
      return { ...state, project: action.project }
    case "SCOPE_SET":
      return { ...state, scope: action.scope }
    case "EXPIRES_AT_SET":
      return { ...state, expiresAt: action.expiresAt }
    case "QUOTA_SET":
      return { ...state, quota: action.quota }
    case "RESET":
      return createInitialFormState(action.project)
    case "CREATING_SET":
      return { ...state, creating: action.creating }
  }
}

export function ApiKeyCreateDialog({
  open,
  onOpenChange,
  defaultProject,
  projects = EMPTY_PROJECTS,
  onCreated,
}: ApiKeyCreateDialogProps) {
  // Issue #73: pick a real Project ID from the user's accessible projects
  // rather than a free-text value. Fall back to the first project when the
  // parent has no current selection, and to "" (disabled) when none exist.
  const initialProject = defaultProject ?? projects[0]?.id ?? ""
  const [form, dispatch] = useReducer(
    createKeyFormReducer,
    initialProject,
    createInitialFormState,
  )
  const { name, project, scope, expiresAt, quota, creating } = form

  const hasProjects = projects.length > 0

  const handleOpenChange = useCallback((next: boolean) => {
    if (next) {
      dispatch({ type: "RESET", project: defaultProject ?? projects[0]?.id ?? "" })
    }
    onOpenChange(next)
  }, [defaultProject, projects, onOpenChange])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!hasProjects || !project) return
    dispatch({ type: "CREATING_SET", creating: true })
    try {
      const trimmedQuota = quota.trim()
      const result = await createApiKey(
        name.trim() || "Default",
        project,
        scope,
        expiresAt ? new Date(expiresAt).toISOString() : undefined,
        trimmedQuota === "" ? null : Number(trimmedQuota),
      )
      onCreated(result)
      onOpenChange(false)
      toast.success("API key created")
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create API key")
    } finally {
      dispatch({ type: "CREATING_SET", creating: false })
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
              onChange={(e) => dispatch({ type: "NAME_SET", name: e.target.value })}
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
              onChange={(e) => dispatch({ type: "PROJECT_SET", project: e.target.value })}
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
              onChange={(e) => dispatch({ type: "SCOPE_SET", scope: e.target.value as ApiKeyScope })}
              className="h-8 w-full min-w-0 rounded-none border border-input bg-input/30 px-2.5 py-1 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              <option value="ingest">Ingest only — recommended for telemetry producers</option>
              <option value="full">Full access — CLI and management</option>
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-expires">Expires (optional)</Label>
            <Input
              id="api-key-expires"
              type="date"
              value={expiresAt}
              onChange={(e) => dispatch({ type: "EXPIRES_AT_SET", expiresAt: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-quota">Daily span quota (optional)</Label>
            <Input
              id="api-key-quota"
              inputMode="numeric"
              placeholder="unlimited"
              value={quota}
              onChange={(e) => dispatch({ type: "QUOTA_SET", quota: e.target.value })}
            />
            <span className="text-[11px] text-muted-foreground">
              Accepted spans per UTC day, per key. Over-quota gets 429 until midnight UTC.
            </span>
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
