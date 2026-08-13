import { ImageResponse } from "next/og";
import { getServerBackendBaseUrl } from "@/lib/config.server";
import { getServerCookieHeader } from "@/lib/backend-fetch.server";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";
export const alt = "apo comparison";
export const maxDuration = 10;

const C = {
  black: "#000",
  white: "#fff",
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
  runs: { pass_result: boolean | null }[];
};

async function tryFetchOverview(projectId: string, comparisonId: string): Promise<OverviewData | null> {
  try {
    const base = getServerBackendBaseUrl();
    const cookieHeader = await getServerCookieHeader();
    const headers: Record<string, string> = {};
    if (cookieHeader) headers["Cookie"] = cookieHeader;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(
      `${base}/v1/projects/${encodeURIComponent(projectId)}/task-view-comparisons/${encodeURIComponent(comparisonId)}/overview`,
      { headers, cache: "no-store", signal: controller.signal },
    );
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return (await resp.json()) as OverviewData;
  } catch {
    return null;
  }
}

function modelLabel(config: { model: string | null; effort: string | null }): string {
  return config.model ?? "All models";
}

export default async function Image({
  params,
}: {
  params: Promise<{ projectId: string; comparisonId: string }>;
}) {
  const { projectId, comparisonId } = await params;

  let overview: OverviewData | null = null;
  try {
    overview = await tryFetchOverview(projectId, comparisonId);
  } catch {
    overview = null;
  }

  if (!overview) {
    return new ImageResponse(brandedFallback(), { ...size });
  }

  const { snapshot } = overview;
  const taskCount = `${snapshot.resolved.length} tasks`;
  const leftModel = modelLabel(snapshot.view_a_config);
  const rightModel = modelLabel(snapshot.view_b_config);
  const leftSide = snapshot.resolved.filter((c) => c.a_status !== null).length;
  const rightSide = snapshot.resolved.filter((c) => c.b_status !== null).length;
  const leftPasses = snapshot.resolved.filter((c) => c.a_status === "passed").length;
  const rightPasses = snapshot.resolved.filter((c) => c.b_status === "passed").length;

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.black, padding: "64px", fontFamily: "sans-serif", color: C.white }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div style={{ display: "flex", fontSize: "52px", fontWeight: 700, letterSpacing: "-2px", color: C.white }}>apo</div>
          <div style={{ display: "flex", padding: "6px 14px", borderRadius: "999px", backgroundColor: C.gray6, border: `1px solid ${C.border}`, color: C.gray2, fontSize: "18px", fontWeight: 500 }}>Comparison</div>
          <div style={{ display: "flex", marginLeft: "auto", fontSize: "20px", color: C.gray3 }}>{taskCount}</div>
        </div>
        <div style={{ display: "flex", marginTop: "40px", height: "1px", backgroundColor: C.border }} />
        <div style={{ display: "flex", flex: 1, marginTop: "48px", gap: "32px" }}>
          {column("View A", leftModel, leftPasses, leftSide)}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "48px", fontSize: "24px", fontWeight: 600, color: C.gray3 }}>vs</div>
          {column("View B", rightModel, rightPasses, rightSide)}
        </div>
      </div>
    ),
    { ...size },
  );
}

function column(label: string, model: string, passes: number, total: number) {
  const fails = total - passes;
  const passRate = total > 0 ? Math.round((passes / total) * 100) : 0;
  const barColor = passRate >= 80 ? C.success : passRate < 50 ? C.destructive : C.warning;
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "20px" }}>
      <div style={{ display: "flex", fontSize: "20px", fontWeight: 600, color: C.gray2 }}>{label}</div>
      <div style={{ display: "flex", fontSize: "32px", fontWeight: 700, color: C.white }}>{model}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: "12px" }}>
        <div style={{ display: "flex", fontSize: "56px", fontWeight: 700, color: C.success }}>{`${passes}`}</div>
        <div style={{ display: "flex", fontSize: "28px", color: C.gray2 }}>passing</div>
        <div style={{ display: "flex", fontSize: "24px", color: C.gray3 }}>{`${fails} failing`}</div>
      </div>
      <div style={{ display: "flex", height: "12px", borderRadius: "6px", backgroundColor: C.gray6, overflow: "hidden" }}>
        <div style={{ display: "flex", width: `${passRate}%`, height: "100%", backgroundColor: barColor }} />
      </div>
      <div style={{ display: "flex", fontSize: "18px", color: C.gray3 }}>{`${total} tasks ran`}</div>
    </div>
  );
}

function brandedFallback() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%", height: "100%", backgroundColor: C.black, fontFamily: "sans-serif", color: C.white }}>
      <div style={{ display: "flex", fontSize: "96px", fontWeight: 700, letterSpacing: "-4px" }}>apo</div>
      <div style={{ display: "flex", marginTop: "16px", padding: "8px 20px", borderRadius: "999px", backgroundColor: C.gray6, border: `1px solid ${C.border}`, color: C.gray2, fontSize: "24px", fontWeight: 500 }}>Comparison</div>
      <div style={{ display: "flex", marginTop: "32px", fontSize: "20px", color: C.gray3 }}>Sign in to view results</div>
    </div>
  );
}
