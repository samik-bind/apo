import { auth } from "@/auth";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { HostedAccessAdmin } from "@/components/hosted-access/hosted-access-admin";
import { listHostedAccessInvitations } from "@/lib/hosted-access-api";
import { MailPlus } from "lucide-react";

export const metadata = {
  title: "Hosted access",
  description: "Invite-only admission to this apo installation",
};

export default async function HostedAccessSettingsPage() {
  const session = await auth();
  const isAdmin = session?.user?.is_admin === true;

  if (!isAdmin) {
    return (
      <>
        <SettingsPageHeader
          title="Hosted access"
          description="Invite-only admission to this apo installation"
          icon={MailPlus}
        />
        <div className="mx-auto max-w-2xl px-6 py-12 text-center text-sm text-muted-foreground">
          Administrator access required.
        </div>
      </>
    );
  }

  // Prefetch server-side so the admin table renders without a mount
  // fetch; on failure the prop is null and the client falls back to a
  // fresh load with its own error state.
  const invitationsResult = await Promise.allSettled([
    listHostedAccessInvitations(),
  ]);
  const initialInvitations =
    invitationsResult[0].status === "fulfilled"
      ? invitationsResult[0].value
      : null;

  return (
    <>
      <SettingsPageHeader
        title="Hosted access"
        description="Invite-only admission to this apo installation. Each invitation creates one invitee-owned Project — never membership in an existing one."
        icon={MailPlus}
      />
      <HostedAccessAdmin initialInvitations={initialInvitations} />
    </>
  );
}
