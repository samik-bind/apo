import { ImageResponse } from "next/og";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  accent: "#4ade80",
};

let _sphereDataUrl: string | null = null;
function sphereDataUrl(): string {
  if (_sphereDataUrl) return _sphereDataUrl;
  const candidates = [
    join(process.cwd(), "public", "brand", "signal-sphere-small.png"),
    join(process.cwd(), "apps", "dashboard", "public", "brand", "signal-sphere-small.png"),
  ];
  for (const p of candidates) {
    try {
      const buf = readFileSync(p);
      _sphereDataUrl = `data:image/png;base64,${buf.toString("base64")}`;
      return _sphereDataUrl;
    } catch { /* try next */ }
  }
  return "";
}

type OverviewData = {
  snapshot: {
    view_a_config: { model: string | null };
    view_b_config: { model: string | null };
    resolved: { a_status: string | null; b_status: string | null }[];
  };
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

  const sphere = sphereDataUrl();
  const taskCount = overview ? `${overview.snapshot.resolved.length} tasks` : null;
  const leftModel = overview ? (overview.snapshot.view_a_config.model ?? "All models") : null;
  const rightModel = overview ? (overview.snapshot.view_b_config.model ?? "All models") : null;
  const leftPass = overview ? overview.snapshot.resolved.filter((c) => c.a_status === "passed").length : null;
  const leftTotal = overview ? overview.snapshot.resolved.filter((c) => c.a_status !== null).length : null;
  const rightPass = overview ? overview.snapshot.resolved.filter((c) => c.b_status === "passed").length : null;
  const rightTotal = overview ? overview.snapshot.resolved.filter((c) => c.b_status !== null).length : null;

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.black, padding: "72px", fontFamily: "sans-serif", color: C.white }}>
        {/* Header: logo + wordmark + badge */}
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          {sphere ? (
            <img src={sphere} width="72" height="72" style={{ display: "flex", borderRadius: "16px" }} alt="" />
          ) : null}
          <div style={{ display: "flex", fontSize: "56px", fontWeight: 700, letterSpacing: "-2px", color: C.white }}>apo</div>
          <div style={{ display: "flex", marginLeft: "auto", padding: "8px 18px", borderRadius: "999px", backgroundColor: C.gray6, border: `1px solid ${C.border}`, color: C.gray2, fontSize: "20px", fontWeight: 500 }}>Comparison</div>
        </div>

        {/* Accent rule */}
        <div style={{ display: "flex", marginTop: "36px", width: "80px", height: "4px", borderRadius: "2px", backgroundColor: C.accent }} />

        {overview ? (
          <div style={{ display: "flex", marginTop: "40px", gap: "48px" }}>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "12px" }}>
              <div style={{ display: "flex", fontSize: "18px", fontWeight: 600, color: C.gray2 }}>View A</div>
              <div style={{ display: "flex", fontSize: "28px", fontWeight: 700, color: C.white }}>{leftModel}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                <div style={{ display: "flex", fontSize: "48px", fontWeight: 700, color: C.accent }}>{`${leftPass}/${leftTotal}`}</div>
                <div style={{ display: "flex", fontSize: "18px", color: C.gray2 }}>passing</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px", fontWeight: 600, color: C.gray3 }}>vs</div>
            <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "12px" }}>
              <div style={{ display: "flex", fontSize: "18px", fontWeight: 600, color: C.gray2 }}>View B</div>
              <div style={{ display: "flex", fontSize: "28px", fontWeight: 700, color: C.white }}>{rightModel}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
                <div style={{ display: "flex", fontSize: "48px", fontWeight: 700, color: C.accent }}>{`${rightPass}/${rightTotal}`}</div>
                <div style={{ display: "flex", fontSize: "18px", color: C.gray2 }}>passing</div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", marginTop: "48px", fontSize: "28px", fontWeight: 500, color: C.gray2 }}>
            Sign in to view comparison results
          </div>
        )}

        {taskCount ? (
          <div style={{ display: "flex", marginTop: "auto", fontSize: "18px", color: C.gray3 }}>{taskCount} compared</div>
        ) : null}
      </div>
    ),
    { ...size },
  );
}
