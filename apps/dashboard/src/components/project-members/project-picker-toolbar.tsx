"use client"

import type { Project } from "@/lib/projects-api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Check, ChevronDown, PlusIcon } from "lucide-react"

export function ProjectPickerToolbar({
  projects,
  selectedProjectId,
  currentProjectName,
  canManage,
  onSelectProject,
  onInvite,
}: {
  projects: Project[]
  selectedProjectId: string
  currentProjectName: string
  canManage: boolean
  onSelectProject: (id: string) => void
  onInvite: () => void
}) {
  if (projects.length <= 1 && !canManage) return null
  return (
    <div className="flex items-center justify-between gap-3">
      {projects.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1.5 px-1 py-1 text-sm font-medium text-foreground transition-colors hover:bg-muted/40"
            >
              {currentProjectName}
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            {projects.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => onSelectProject(p.id)}
                className="justify-between"
              >
                {p.name}
                {p.id === selectedProjectId && <Check className="size-3.5" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div />
      )}
      {canManage && (
        <Button
          type="button"
          size="sm"
          onClick={onInvite}
        >
          <PlusIcon className="size-3.5" />
          Invite member
        </Button>
      )}
    </div>
  )
}
