import { ServerCog } from "lucide-react";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { ExecutorsClient } from "./executors-client";

export const metadata = { title: "Executors" };

export default function ExecutorsSettingsPage() {
  return (
    <>
      <SettingsPageHeader
        title="Executors"
        description="Choose where dashboard Tasks and schedules run."
        icon={ServerCog}
      />
      <ExecutorsClient />
    </>
  );
}
