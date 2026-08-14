import { ImageResponse } from "next/og";
import { getServerBackendBaseUrl } from "@/lib/config.server";
import { buildSignalSphereScene, renderSignalSphereSvg } from "@/components/brand/signal-sphere-scene";
import { OG_IMAGE_SIZE } from "./og-image-size";

// Route-level export required by Next's ImageResponse metadata contract —
// it emits og:image:width/height from this. Suppressed in doctor.config.json
// because metadata-route exports trip only-export-components.
export const size = OG_IMAGE_SIZE;

export const contentType = "image/png";
export const runtime = "nodejs";
export const alt = "apo comparison";
export const maxDuration = 10;

const C = {
  black: "#000",
  white: "#fff",
  gray2: "#d4d4d4",
  gray3: "#a3a3a3",
  gray6: "#252525",
  gray5: "#404040",
  accent: "#4ade80",
};

const BADGE_STYLE = {
  display: "flex",
  alignSelf: "flex-start",
  padding: "8px 18px",
  borderRadius: "999px",
  backgroundColor: C.gray6,
  border: `1px solid ${C.gray5}`,
  color: C.gray3,
  fontSize: "18px",
  fontWeight: 600,
  letterSpacing: "2px",
  textTransform: "uppercase",
} as const;

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
  // Render the signal sphere through the same renderer as the docs OG image.
  const svg = renderSignalSphereSvg(buildSignalSphereScene(), {
    fg: "#f4f4f5",
    accent: C.accent,
  });
  const sphere = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const leftModel = card?.view_a ?? "All models";
  const rightModel = card?.view_b ?? "All models";

  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%", backgroundColor: C.black, fontFamily: "sans-serif", color: C.white }}>
        {/* Left column */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", width: "720px", padding: "80px" }}>
          {/* Badge */}
          <div style={BADGE_STYLE}>
            Comparison
          </div>
          {/* Wordmark */}
          <div style={{ display: "flex", marginTop: "20px", fontSize: "120px", fontWeight: 700, lineHeight: 1, letterSpacing: "-6px", color: C.white }}>
            apo
          </div>
          {/* Accent rule */}
          <div style={{ display: "flex", marginTop: "12px", width: "100px", height: "5px", borderRadius: "3px", backgroundColor: C.accent }} />
          {/* View A vs View B */}
          <div style={{ display: "flex", marginTop: "36px", gap: "32px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", fontSize: "18px", fontWeight: 600, color: C.gray3 }}>View A</div>
              <div style={{ display: "flex", fontSize: "32px", fontWeight: 700, color: C.white }}>{leftModel}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", fontSize: "20px", fontWeight: 600, color: C.gray5 }}>vs</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <div style={{ display: "flex", fontSize: "18px", fontWeight: 600, color: C.gray3 }}>View B</div>
              <div style={{ display: "flex", fontSize: "32px", fontWeight: 700, color: C.white }}>{rightModel}</div>
            </div>
          </div>
        </div>
        {/* Right column — signal sphere */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flexGrow: 1 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={sphere} width={340} height={340} style={{ display: "flex" }} alt="" />
        </div>
      </div>
    ),
    { ...OG_IMAGE_SIZE },
  );
}
