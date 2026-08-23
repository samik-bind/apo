import { SettingsSidebar } from "@/components/settings-sidebar";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[calc(100svh-3.5rem)] flex-col overflow-hidden md:flex-row">
      <SettingsSidebar />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
