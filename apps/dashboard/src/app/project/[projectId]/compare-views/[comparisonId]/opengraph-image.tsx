import { ImageResponse } from "next/og";
import { getServerBackendBaseUrl } from "@/lib/config.server";

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

type CardData = { view_a: string | null; view_b: string | null };

async function tryFetchCard(projectId: string, comparisonId: string): Promise<CardData | null> {
  try {
    const base = getServerBackendBaseUrl();
    const resp = await fetch(
      `${base}/v1/projects/${encodeURIComponent(projectId)}/task-view-comparisons/${encodeURIComponent(comparisonId)}/card`,
      { cache: "no-store" },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as CardData;
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

  const card = await tryFetchCard(projectId, comparisonId);
  const sphere = "http://localhost:3000/brand/signal-sphere-small.png";
  const leftModel = card?.view_a ?? "All models";
  const rightModel = card?.view_b ?? "All models";

  return new ImageResponse(
    (
      <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", backgroundColor: C.black, padding: "72px", fontFamily: "sans-serif", color: C.white }}>
        <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sphere} width={72} height={72} style={{ display: "flex", borderRadius: "16px" }} alt="" />
          <div style={{ display: "flex", fontSize: "56px", fontWeight: 700, letterSpacing: "-2px", color: C.white }}>apo</div>
          <div style={{ display: "flex", marginLeft: "auto", padding: "8px 18px", borderRadius: "999px", backgroundColor: C.gray6, border: `1px solid ${C.border}`, color: C.gray2, fontSize: "20px", fontWeight: 500 }}>Comparison</div>
        </div>

        <div style={{ display: "flex", marginTop: "36px", width: "80px", height: "4px", borderRadius: "2px", backgroundColor: C.accent }} />

        <div style={{ display: "flex", marginTop: "48px", gap: "48px" }}>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "12px" }}>
            <div style={{ display: "flex", fontSize: "18px", fontWeight: 600, color: C.gray2 }}>View A</div>
            <div style={{ display: "flex", fontSize: "32px", fontWeight: 700, color: C.white }}>{leftModel}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px", fontWeight: 600, color: C.gray3 }}>vs</div>
          <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: "12px" }}>
            <div style={{ display: "flex", fontSize: "18px", fontWeight: 600, color: C.gray2 }}>View B</div>
            <div style={{ display: "flex", fontSize: "32px", fontWeight: 700, color: C.white }}>{rightModel}</div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
