import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GaiaLog — Environmental Blockchain Monitoring",
    short_name: "GaiaLog",
    description:
      "Real-time environmental monitoring with every measurement recorded immutably on the BSV blockchain.",
    start_url: "/",
    display: "standalone",
    background_color: "#0b1120",
    theme_color: "#6366f1",
    icons: [
      {
        src: "/gaialog-logo-128.png",
        sizes: "128x128",
        type: "image/png",
        purpose: "any",
      },
    ],
  }
}
