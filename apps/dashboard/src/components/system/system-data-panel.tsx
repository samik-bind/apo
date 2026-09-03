"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { isUnauthorized } from "@/lib/api-error";
import { fetchDbTableStats, type DbTableStats } from "@/lib/system-api";

/**
 * Row counts per database table, loaded on demand. Retention policy itself
 * lives under Project → Retention.
 */
export function SystemDataPanel() {
  const [stats, setStats] = useState<DbTableStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStats(await fetchDbTableStats());
    } catch (e) {
      setStats(null);
      setError(
        isUnauthorized(e)
          ? "Rejected — set the same ADMIN_API_KEY on the backend and the dashboard to enable table counts."
          : "Table counts unavailable — the admin stats call failed.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <section className="border bg-card p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Database Contents</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Row counts per table. Retention policy lives under Project →
            Retention.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={load}
          disabled={loading}
        >
          {loading ? "Loading…" : stats ? "Reload Counts" : "Load Counts"}
        </Button>
      </div>
      {error ? (
        <p className="text-[13px] text-muted-foreground">{error}</p>
      ) : stats ? (
        <div className="grid grid-cols-2 gap-px border bg-border sm:grid-cols-4">
          {Object.entries(stats)
            .toSorted(([a], [b]) => a.localeCompare(b))
            .map(([table, count]) => (
              <div key={table} className="bg-card p-3">
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {table}
                </div>
                <div className="mt-1 font-mono text-lg tabular-nums">
                  {count}
                </div>
              </div>
            ))}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          Counts not loaded yet.
        </p>
      )}
    </section>
  );
}
