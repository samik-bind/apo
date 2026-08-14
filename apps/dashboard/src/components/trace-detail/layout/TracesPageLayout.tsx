"use client";

import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { TraceFilterControls, type TraceFilterOptions } from "@/components/trace-filter-controls";
import { TraceActiveFilters } from "@/components/trace-active-filters";
import { useFilters } from "@/hooks/use-filters";
import { useRouter } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Suspense, type ReactNode, useCallback, useSyncExternalStore } from "react";

export interface TracesPageLayoutProps {
  children: ReactNode;
  filterOptions?: TraceFilterOptions;
}

const CSV_REMOVE_KEYS = ["environment", "status", "user_id", "session_id"];

const FILTERS_VISIBLE_STORAGE_KEY = "traces-filters-visible";
const filtersVisibleListeners = new Set<() => void>();

function readStoredFiltersVisible(): string | null {
  try {
    return window.localStorage.getItem(FILTERS_VISIBLE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function subscribeToStoredFiltersVisible(onChange: () => void) {
  filtersVisibleListeners.add(onChange);
  // storage covers other tabs; same-tab toggles notify listeners directly.
  window.addEventListener("storage", onChange);
  return () => {
    filtersVisibleListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function writeStoredFiltersVisible(next: boolean) {
  try {
    window.localStorage.setItem(FILTERS_VISIBLE_STORAGE_KEY, String(next));
  } catch {
    // localStorage unavailable — the notification below still lets the
    // in-flight readers re-evaluate.
  }
  filtersVisibleListeners.forEach((notify) => notify());
}

/**
 * Filters-panel visibility, backed by localStorage as an external store.
 * useSyncExternalStore keeps the server/hydration snapshot neutral (null →
 * visible, the pre-persist default) and re-renders when the value changes —
 * no mount effect initializing state from a browser global. Same pattern as
 * hooks/use-mobile.tsx.
 */
function useFiltersVisible(): boolean {
  const stored = useSyncExternalStore(
    subscribeToStoredFiltersVisible,
    readStoredFiltersVisible,
    () => null,
  );
  return stored !== "false";
}

function getBasePath(pathname: string | null, fallback: string): string {
  if (!pathname?.startsWith("/project/")) return fallback;
  return pathname.replace(/\/traces.*$/, "/traces") || fallback;
}

function TracesPageLayoutInner({ children, filterOptions }: TracesPageLayoutProps) {
  const [filters, actions] = useFilters();
  const router = useRouter();
  const filtersVisible = useFiltersVisible();

  const toggleFilters = useCallback(() => {
    writeStoredFiltersVisible(!filtersVisible);
  }, [filtersVisible]);

  const handleRemoveFilter = (key: keyof typeof filters, value?: any) => {
    const basePath = getBasePath(window.location.pathname, "/traces");
    if (key === "tags" && Array.isArray(value)) {
      actions.setTags(value);
    } else if (key === "models" && Array.isArray(value)) {
      actions.setModels(value);
    } else if (CSV_REMOVE_KEYS.includes(key as string) && typeof value === "string") {
      const params = new URLSearchParams(window.location.search);
      const paramKey = key;
      const current = params.get(paramKey)?.split(",").filter(Boolean) ?? [];
      const next = current.filter((v) => v !== value);
      if (next.length > 0) {
        params.set(paramKey, next.join(","));
      } else {
        params.delete(paramKey);
      }
      router.push(`${basePath}?${params.toString()}`);
    } else {
      actions.removeFilter(key);
    }
  };

  return (
    <div className="relative h-full w-full">
      {filtersVisible && (
        <ResizablePanelGroup direction="horizontal" className="h-full w-full">
          <ResizablePanel defaultSize="25%" minSize="20%" className="overflow-auto">
            <div className="h-full w-full border-r p-4 overflow-y-auto">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Filters
                </span>
                <button
                  type="button"
                  onClick={toggleFilters}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Hide filters"
                  title="Hide filters"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-4">
                <TraceFilterControls
                  filters={filters}
                  actions={actions}
                  availableEnvironments={["default", "dev", "staging", "production"]}
                  filterOptions={filterOptions}
                />

                <TraceActiveFilters
                  filters={filters}
                  onRemoveFilter={handleRemoveFilter}
                  onClearAll={actions.clearAllFilters}
                />
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle />

          <ResizablePanel defaultSize="75%" minSize="60%" className="overflow-auto">
            {children}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}

      {!filtersVisible && (
        <div className="relative h-full w-full overflow-auto">
          <button
            type="button"
            onClick={toggleFilters}
            className="absolute left-3 top-3 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Show filters"
            title="Show filters"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          {children}
        </div>
      )}
    </div>
  );
}

export function TracesPageLayout({ children, filterOptions }: TracesPageLayoutProps) {
  return (
    <Suspense>
      <TracesPageLayoutInner filterOptions={filterOptions}>{children}</TracesPageLayoutInner>
    </Suspense>
  );
}
