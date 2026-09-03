import { auth } from "@/auth";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { SystemSection } from "@/components/admin/system-section";
import { ProjectResetSection } from "@/components/admin/project-reset-section";
import { SystemRuntimePanel } from "@/components/system-runtime-panel";
import { TaskRuntimeStatusPanel } from "@/components/task-runtime-status-panel";
import {
  fetchReadinessReport,
  fetchRuntimeConfig,
  fetchTaskRuntimeStatus,
} from "@/lib/system-api";
import { ShieldAlert } from "lucide-react";

// PROTOTYPE — System settings IA prototype (see ./_prototype/NOTES.md).
// ?variant=a|b|c renders a redesign candidate; ?variant=current or no param
// renders today's page unchanged. Switcher + variants are dev-only.
import { PrototypeSwitcher } from "./_prototype/prototype-switcher";
import { isPrototypeVariant } from "./_prototype/variant-keys";
import { SystemVariantA } from "./_prototype/variants/system-variant-a";
import { SystemVariantB } from "./_prototype/variants/system-variant-b";
import { SystemVariantC } from "./_prototype/variants/system-variant-c";

export const metadata = {
  title: "System",
  description: "Internal system operations for the agent-testing platform",
};

export default async function SystemSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  // Fetch initial panel data server-side so the client panels don't need a
  // mount-init fetch. Each request is best-effort: on failure we leave the
  // prop null so the panel renders its empty state and the user can Retry.
  const [configResult, readinessResult, statusResult] = await Promise.allSettled([
    fetchRuntimeConfig(),
    fetchReadinessReport(),
    fetchTaskRuntimeStatus(),
  ]);
  const initialConfig =
    configResult.status === "fulfilled" ? configResult.value : null;
  const initialReadiness =
    readinessResult.status === "fulfilled" ? readinessResult.value : null;
  const initialStatus =
    statusResult.status === "fulfilled" ? statusResult.value : null;

  const params = await searchParams;
  const rawVariant = params?.variant;
  const requested = (Array.isArray(rawVariant) ? rawVariant[0] : rawVariant) ?? "";
  const variant = isPrototypeVariant(requested) ? requested : "";
  const showPrototype =
    process.env.NODE_ENV !== "production" && variant !== "";
  const initialSnapshot = {
    config: initialConfig,
    readiness: initialReadiness,
    status: initialStatus,
  };

  if (showPrototype && variant !== "current") {
    return (
      <>
        {variant === "a" ? <SystemVariantA initial={initialSnapshot} /> : null}
        {variant === "b" ? <SystemVariantB initial={initialSnapshot} /> : null}
        {variant === "c" ? <SystemVariantC initial={initialSnapshot} /> : null}
        <PrototypeSwitcher current={variant} />
      </>
    );
  }

  return (
    <>
      <SettingsPageHeader
        title="System"
        description="Internal system operations for the agent-testing platform."
        icon={ShieldAlert}
      />
      <SystemRuntimePanel
        initialConfig={initialConfig}
        initialReadiness={initialReadiness}
      />
      <div className="mt-6">
        <TaskRuntimeStatusPanel initialStatus={initialStatus} />
      </div>
      <div className="mt-6">
        <SystemSection />
      </div>
      <div className="mt-6">
        <ProjectResetSection />
      </div>
      {showPrototype ? <PrototypeSwitcher current="current" /> : null}
    </>
  );
}
