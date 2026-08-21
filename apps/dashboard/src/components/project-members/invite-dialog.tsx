"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function InviteDialog({
  open,
  onOpenChange,
  inviteEmail,
  onInviteEmailChange,
  inviteRole,
  onInviteRoleChange,
  inviteError,
  inviting,
  onInvite,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  inviteEmail: string
  onInviteEmailChange: (value: string) => void
  inviteRole: "admin" | "member"
  onInviteRoleChange: (role: "admin" | "member") => void
  inviteError: string | null
  inviting: boolean
  onInvite: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite member</DialogTitle>
          <DialogDescription>
            We&rsquo;ll email them an invitation — or, if email isn&rsquo;t set
            up, give you a link to share. They can join even without an account.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label htmlFor="invite-email" className="mb-1 block text-xs text-muted-foreground">
              Email
            </label>
            <Input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onInviteEmailChange(e.target.value)}
              className="h-9"
              placeholder="teammate@example.com"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="invite-role" className="mb-1 block text-xs text-muted-foreground">
              Role
            </label>
            <Select
              value={inviteRole}
              onValueChange={(v) => onInviteRoleChange(v as "admin" | "member")}
            >
              <SelectTrigger id="invite-role" className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {inviteError && <p className="text-xs text-destructive">{inviteError}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onInvite}
            disabled={inviting || !inviteEmail.trim()}
          >
            {inviting ? "Sending…" : "Send invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
