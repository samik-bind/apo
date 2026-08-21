"use client"

import type { ProjectMemberSummary } from "@/lib/project-members-api"
import type { ProjectInvitationSummary } from "@/lib/project-invitations-api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export function ConfirmationDialogs({
  removeTarget,
  revokeTarget,
  busy,
  onCloseRemove,
  onConfirmRemove,
  onCloseRevoke,
  onConfirmRevoke,
}: {
  removeTarget: ProjectMemberSummary | null
  revokeTarget: ProjectInvitationSummary | null
  busy: boolean
  onCloseRemove: () => void
  onConfirmRemove: () => void
  onCloseRevoke: () => void
  onConfirmRevoke: () => void
}) {
  return (
    <>
      {/* Remove confirmation */}
      <Dialog open={!!removeTarget} onOpenChange={(o) => !o && onCloseRemove()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove member</DialogTitle>
            <DialogDescription>
              Remove{" "}
              <span className="font-medium text-foreground">
                {removeTarget?.name || removeTarget?.email}
              </span>{" "}
              from this project? They lose access immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCloseRemove}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirmRemove} disabled={busy}>
              {busy ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <Dialog open={!!revokeTarget} onOpenChange={(o) => !o && onCloseRevoke()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Revoke invitation</DialogTitle>
            <DialogDescription>
              Revoke the invitation to{" "}
              <span className="font-medium text-foreground">{revokeTarget?.email}</span>? They
              won&rsquo;t be able to accept it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCloseRevoke}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={onConfirmRevoke} disabled={busy}>
              {busy ? "Revoking…" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
