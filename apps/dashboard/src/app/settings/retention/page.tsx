"use client";

import { SettingsPageHeader } from "@/components/settings/page-header";
import { EvidenceRetentionSection } from "@/components/settings/evidence-retention-section";
import { Hourglass } from "lucide-react";

export default function RetentionSettingsPage() {
  return (
    <>
      <SettingsPageHeader
        title="Retention"
        description="How long each project keeps run evidence. Verdicts are never deleted automatically."
        icon={Hourglass}
      />
      <div className="mx-auto max-w-3xl px-6 py-8">
        <EvidenceRetentionSection />
      </div>
    </>
  );
}
