import { ImageResponse } from "next/og"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export const runtime = "nodejs"
export const alt = "GaiaLog — Environmental Blockchain Monitoring"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function OpengraphImage() {
  const logoData = await readFile(join(process.cwd(), "public", "gaialog-logo-128.png"))
  const logoSrc = `data:image/png;base64,${logoData.toString("base64")}`

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
          background: "linear-gradient(135deg, #020617 0%, #0f172a 55%, #1e1b4b 100%)",
          position: "relative",
        }}
      >
        {/* Accent glow */}
        <div
          style={{
            position: "absolute",
            top: -160,
            right: -120,
            width: 520,
            height: 520,
            borderRadius: 9999,
            background: "radial-gradient(circle, rgba(99,102,241,0.35) 0%, rgba(99,102,241,0) 70%)",
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -180,
            left: -100,
            width: 480,
            height: 480,
            borderRadius: 9999,
            background: "radial-gradient(circle, rgba(168,85,247,0.28) 0%, rgba(168,85,247,0) 70%)",
            display: "flex",
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={logoSrc} width={110} height={110} alt="" style={{ borderRadius: 24 }} />
          <div
            style={{
              fontSize: 96,
              fontWeight: 700,
              color: "#f8fafc",
              letterSpacing: -3,
              display: "flex",
            }}
          >
            GaiaLog
          </div>
        </div>

        <div
          style={{
            marginTop: 28,
            fontSize: 34,
            color: "#c7d2fe",
            maxWidth: 880,
            textAlign: "center",
            lineHeight: 1.4,
            display: "flex",
          }}
        >
          Real-time environmental data, recorded immutably on the BSV blockchain
        </div>

        <div
          style={{
            marginTop: 44,
            display: "flex",
            gap: 16,
          }}
        >
          {["Air Quality", "Water Levels", "Seismic", "Blockchain Verified"].map((label) => (
            <div
              key={label}
              style={{
                display: "flex",
                padding: "10px 24px",
                borderRadius: 9999,
                border: "1px solid rgba(129,140,248,0.4)",
                background: "rgba(30,27,75,0.5)",
                color: "#e0e7ff",
                fontSize: 22,
              }}
            >
              {label}
            </div>
          ))}
        </div>

        <div
          style={{
            position: "absolute",
            bottom: 36,
            fontSize: 24,
            color: "#64748b",
            display: "flex",
          }}
        >
          gaialog.world
        </div>
      </div>
    ),
    size,
  )
}
