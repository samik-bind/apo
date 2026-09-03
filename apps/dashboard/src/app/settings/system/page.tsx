import { auth } from "@/auth";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { SystemOverview } from "@/components/system/system-overview";
import {
  fetchReadinessReport,
  fetchRuntimeConfig,
  fetchTaskRuntimeStatus,
} from "@/lib/system-api";
import { ShieldAlert } from "lucide-react";

export const metadata = {
  title: "System",
  description: "Internal system operations for the agent-testing platform",
};

export default async function SystemSettingsPage() {
  const session = await auth();
  const isAdmin = session?.user?.is_admin === true;

  if (!isAdmin) {
    return (
      <>
        <SettingsPageHeader title="System" description="Internal system operations" icon={ShieldAlert} />
        <div className="mx-auto max-w-2xl px-6 py-12 text-center text-sm text-muted-foreground">
          Administrator access required.
        </div>
      </>
    );
  }

  // Fetch initial data server-side so the client overview doesn't need a
  // mount-init fetch. Each request is best-effort: on failure we leave the
  // prop null so the overview renders its empty state and the user can hit
  // Refresh.
  const [configResult, readinessResult, statusResult] = await Promise.allSettled([
    fetchRuntimeConfig(),
    fetchReadinessReport(),
    fetchTaskRuntimeStatus(),
  ]);

  return (
    <SystemOverview
      initialConfig={configResult.status === "fulfilled" ? configResult.value : null}
      initialReadiness={readinessResult.status === "fulfilled" ? readinessResult.value : null}
      initialStatus={statusResult.status === "fulfilled" ? statusResult.value : null}
    />
  );
}
