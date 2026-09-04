import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#070b16",
          padding: 72,
          color: "#e2e8f0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              background: "#0b1020",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "1px solid #1e293b",
              fontSize: 28,
              color: "#2dd4bf",
            }}
          >
            ·
          </div>
          <div style={{ fontSize: 22, letterSpacing: "0.18em", color: "#94a3b8" }}>
            STRUCTURE-GROUNDED AMR
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ fontSize: 64, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.1 }}>
            AMR Resistance Copilot
          </div>
          <div style={{ fontSize: 26, color: "#94a3b8", maxWidth: 820, lineHeight: 1.4 }}>
            Locate a mutation on the drug target and measure its relationship to the
            binding site — including mutations no catalogue has seen.
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
