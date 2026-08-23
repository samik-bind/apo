"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ArrowLeft, Menu } from "lucide-react";
import {
  INSTANCE_ITEMS,
  PERSONAL_ITEMS,
  PROJECT_ITEMS,
  settingsHref,
  type SettingsNavItem,
} from "@/app/settings/nav-config";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

export function SettingsSidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.is_admin === true;
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);

  const groups = [
    { label: "Personal", items: PERSONAL_ITEMS },
    { label: "Project", items: PROJECT_ITEMS },
    ...(isAdmin ? [{ label: "Instance", items: INSTANCE_ITEMS }] : []),
  ];
  const activeLabel = groups
    .flatMap((g) => g.items)
    .find(
      (item) =>
        pathname === settingsHref(item) ||
        pathname.startsWith(settingsHref(item) + "/"),
    )?.label;

  if (isMobile) {
    return (
      <>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-4">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open settings menu"
            className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Menu className="size-4" />
          </button>
          <span className="text-sm font-semibold">Settings</span>
          {activeLabel && (
            <span className="truncate text-xs text-muted-foreground">
              {activeLabel}
            </span>
          )}
        </div>
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent
            side="left"
            className="w-4/5 max-w-xs p-0 sm:max-w-xs"
          >
            <SheetHeader className="border-b border-border">
              <SheetTitle className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                Settings
              </SheetTitle>
            </SheetHeader>
            <nav className="flex-1 overflow-y-auto px-3 py-4">
              {groups.map((group, i) => (
                <div key={group.label} className={cn(i > 0 && "mt-6")}>
                  <SidebarGroup
                    label={group.label}
                    items={group.items}
                    pathname={pathname}
                    onNavigate={() => setMenuOpen(false)}
                  />
                </div>
              ))}
            </nav>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <aside className="hidden h-full w-56 shrink-0 flex-col border-r border-border bg-background md:flex">
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Dashboard
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <p className="mb-3 px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
          Settings
        </p>

        <SidebarGroup label="Personal" items={PERSONAL_ITEMS} pathname={pathname} />

        <div className="mt-6">
          <SidebarGroup label="Project" items={PROJECT_ITEMS} pathname={pathname} />
        </div>

        {isAdmin && (
          <div className="mt-6">
            <SidebarGroup
              label="Instance"
              items={INSTANCE_ITEMS}
              pathname={pathname}
            />
          </div>
        )}
      </nav>
    </aside>
  );
}

function SidebarGroup({
  label,
  items,
  pathname,
  onNavigate,
}: {
  label: string;
  items: SettingsNavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 px-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          {label}
        </p>
      </div>
      <ul className="space-y-0.5">
        {items.map((item) => {
          const href = settingsHref(item);
          const isActive = pathname === href || pathname.startsWith(href + "/");
          const Icon = item.icon;
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors",
                  isActive
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
