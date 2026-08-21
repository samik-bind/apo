"use client"

import type { ProjectMemberSummary } from "@/lib/project-members-api"
import type { ProjectInvitationSummary } from "@/lib/project-invitations-api"
import type { ProjectRole } from "@/lib/projects-api"
import { Loader2, ShieldCheckIcon } from "lucide-react"
import { MembersTable, type Row } from "./members-table"

export function MembersContent({
  loading,
  canManage,
  rows,
  currentUserId,
  ownerCount,
  resendingId,
  onChangeRole,
  onRemove,
  onResend,
  onRevoke,
}: {
  loading: boolean
  canManage: boolean
  rows: Row[]
  currentUserId: string | undefined
  ownerCount: number
  resendingId: string | null
  onChangeRole: (member: ProjectMemberSummary, newRole: ProjectRole) => void
  onRemove: (member: ProjectMemberSummary) => void
  onResend: (invitation: ProjectInvitationSummary) => void
  onRevoke: (invitation: ProjectInvitationSummary) => void
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!canManage) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        <ShieldCheckIcon className="mx-auto mb-2 size-4 text-muted-foreground" />
        You need admin or owner access to manage members.
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No members yet. Invite someone with the box above.
      </div>
    )
  }
  return (
    <MembersTable
      rows={rows}
      canManage={canManage}
      currentUserId={currentUserId}
      ownerCount={ownerCount}
      resendingId={resendingId}
      onChangeRole={onChangeRole}
      onRemove={onRemove}
      onResend={onResend}
      onRevoke={onRevoke}
    />
  )
}
