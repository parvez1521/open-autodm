import { ImageResponse } from "next/og";

/**
 * Social card (SEO pass, 2026-11-10, plan P0-1): 1200×630,
 * rendered with the site's Open Caption design tokens — cream
 * #FFFFEB ground, obsidian #1A1A1A ink, lavender #F0D7FF pill,
 * emerald #34D399 rule, orange #FFA946 accent. Flat colours only:
 * no gradient, no emoji (owner ban list). Applies site-wide via
 * the file convention; twitter-image.tsx re-exports it.
 */
export const alt =
  "open-autoDM — Instagram Auto DM: comment-to-DM automation for creators";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: "#FFFFEB",
          padding: "64px 72px",
          fontFamily: "sans-serif",
          color: "#1A1A1A",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              backgroundColor: "#F0D7FF",
              borderRadius: 999,
              padding: "10px 22px",
              fontSize: 26,
              fontWeight: 700,
            }}
          >
            open-<span style={{ fontStyle: "italic", fontWeight: 400 }}>autoDM</span>
          </div>
          <div style={{ fontSize: 24, color: "#1A1A1A", opacity: 0.6 }}>
            opendm.in
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 22,
              fontSize: 84,
              fontWeight: 800,
              lineHeight: 1.05,
            }}
          >
            <span>Instagram</span>
            <span style={{ fontStyle: "italic", fontWeight: 400 }}>Auto DM</span>
          </div>
          <div
            style={{
              marginTop: 24,
              fontSize: 32,
              lineHeight: 1.35,
              maxWidth: 900,
              opacity: 0.75,
            }}
          >
            Someone comments your keyword — open-autoDM replies publicly and
            sends the DM automatically.
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              width: 96,
              height: 8,
              borderRadius: 999,
              backgroundColor: "#34D399",
              marginBottom: 24,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 26 }}>
            <span style={{ fontWeight: 700 }}>Free plan</span>
            <span style={{ color: "#FFA946", fontWeight: 800 }}>·</span>
            <span>Unlimited DMs</span>
            <span style={{ color: "#FFA946", fontWeight: 800 }}>·</span>
            <span>Unlimited automations</span>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
