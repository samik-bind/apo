import { ImageResponse } from "next/og";
import { getServerBackendBaseUrl } from "@/lib/config.server";
import { getServerCookieHeader } from "@/lib/backend-fetch.server";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";
export const alt = "apo comparison";

const COLORS = {
  black: "#000000",
  white: "#ffffff",
  gray1: "#f4f4f5",
  gray2: "#a3a3a3",
  gray3: "#525252",
  gray6: "#1a1a1a",
  border: "#262626",
  success: "#4ade80",
  destructive: "#f87171",
  warning: "#fbbf24",
};

type OverviewData = {
  snapshot: {
    view_a_config: { model: string | null; effort: string | null };
    view_b_config: { model: string | null; effort: string | null };
    resolved: { a_status: string | null; b_status: string | null }[];
  };
  runs: { pass_result: boolean | null; status: string; total_checks: number; passed_checks: number }[];
};

async function tryFetchOverview(projectId: string, comparisonId: string): Promise<OverviewData | null> {
  try {
    const base = getServerBackendBaseUrl();
    const cookieHeader = await getServerCookieHeader();
    const headers: Record<string, string> = {};
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    const resp = await fetch(
      `${base}/v1/projects/${encodeURIComponent(projectId)}/task-view-comparisons/${encodeURIComponent(comparisonId)}/overview`,
      { headers, cache: "no-store" },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as OverviewData;
  } catch {
    return null;
  }
}

function modelLabel(config: { model: string | null; effort: string | null }): string {
  const parts = [config.model ?? "All models"];
  if (config.effort) parts.push(config.effort);
  return parts.join(" · ");
}

export default async function Image({
  params,
}: {
  params: Promise<{ projectId: string; comparisonId: string }>;
}) {
  const { projectId, comparisonId } = await params;
  const overview = await tryFetchOverview(projectId, comparisonId);

  if (!overview) {
    return brandedFallback();
  }

  const { snapshot, runs } = overview;
  const taskCount = snapshot.resolved.length;
  const leftModel = modelLabel(snapshot.view_a_config);
  const rightModel = modelLabel(snapshot.view_b_config);
  const leftPasses = runs.filter(
    (r) => snapshot.resolved.some((c) => c.a_status !== null) && r.pass_result === true,
  ).length;
  const rightPasses = runs.filter(
    (r) => snapshot.resolved.some((c) => c.b_status !== null) && r.pass_result === true,
  ).length;
  const leftSideCount = snapshot.resolved.filter((c) => c.a_status !== null).length;
  const rightSideCount = snapshot.resolved.filter((c) => c.b_status !== null).length;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: COLORS.black,
          padding: "64px",
          fontFamily: "sans-serif",
          color: COLORS.white,
        }}
      >
        {/* Header: wordmark + label */}
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ fontSize: "52px", fontWeight: 700, letterSpacing: "-2px", color: COLORS.white }}>
            apo
          </div>
          <div
            style={{
              display: "flex",
              padding: "6px 14px",
              borderRadius: "999px",
              backgroundColor: COLORS.gray6,
              border: `1px solid ${COLORS.border}`,
              color: COLORS.gray2,
              fontSize: "18px",
              fontWeight: 500,
            }}
          >
            Comparison
          </div>
          <div style={{ marginLeft: "auto", fontSize: "20px", color: COLORS.gray3 }}>
            {taskCount} task{taskCount === 1 ? "" : "s"}
          </div>
        </div>

        {/* Divider */}
        <div style={{ display: "flex", marginTop: "40px", height: "1px", backgroundColor: COLORS.border }} />

        {/* Two columns: View A vs View B */}
        <div style={{ display: "flex", flex: 1, marginTop: "48px", gap: "32px" }}>
          {/* Left side */}
          <ComparisonColumn
            label="View A"
            model={leftModel}
            passes={leftPasses}
            total={leftSideCount}
          />

          {/* VS separator */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: "48px",
              fontSize: "24px",
              fontWeight: 600,
              color: COLORS.gray3,
            }}
          >
            vs
          </div>

          {/* Right side */}
          <ComparisonColumn
            label="View B"
            model={rightModel}
            passes={rightPasses}
            total={rightSideCount}
          />
        </div>
      </div>
    ),
    { ...size },
  );
}

function ComparisonColumn({
  label,
  model,
  passes,
  total,
}: {
  label: string;
  model: string;
  passes: number;
  total: number;
}) {
  const fails = total - passes;
  const passRate = total > 0 ? Math.round((passes / total) * 100) : 0;
  const barColor = passRate >= 80 ? COLORS.success : passRate < 50 ? COLORS.destructive : COLORS.warning;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "20px" }}>
      <div style={{ display: "flex", fontSize: "20px", fontWeight: 600, color: COLORS.gray2 }}>
        {label}
      </div>
      <div style={{ display: "flex", fontSize: "32px", fontWeight: 700, color: COLORS.white }}>
        {model}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px", marginTop: "8px" }}>
        <span style={{ fontSize: "56px", fontWeight: 700, color: COLORS.success }}>{passes}</span>
        <span style={{ fontSize: "28px", color: COLORS.gray2 }}>passing</span>
        <span style={{ fontSize: "24px", color: COLORS.gray3 }}>· {fails} failing</span>
      </div>
      {/* Proportion bar */}
      <div
        style={{
          display: "flex",
          height: "12px",
          borderRadius: "6px",
          backgroundColor: COLORS.gray6,
          marginTop: "8px",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", width: `${passRate}%`, height: "100%", backgroundColor: barColor }} />
      </div>
      <div style={{ display: "flex", fontSize: "18px", color: COLORS.gray3 }}>
        {total} task{total === 1 ? "" : "s"} ran
      </div>
    </div>
  );
}

function brandedFallback(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: COLORS.black,
          fontFamily: "sans-serif",
          color: COLORS.white,
        }}
      >
        <div style={{ display: "flex", fontSize: "96px", fontWeight: 700, letterSpacing: "-4px" }}>
          apo
        </div>
        <div
          style={{
            display: "flex",
            marginTop: "16px",
            padding: "8px 20px",
            borderRadius: "999px",
            backgroundColor: COLORS.gray6,
            border: `1px solid ${COLORS.border}`,
            color: COLORS.gray2,
            fontSize: "24px",
            fontWeight: 500,
          }}
        >
          Comparison
        </div>
        <div style={{ display: "flex", marginTop: "32px", fontSize: "20px", color: COLORS.gray3 }}>
          Sign in to view results
        </div>
      </div>
    ),
    { ...size },
  );
}
