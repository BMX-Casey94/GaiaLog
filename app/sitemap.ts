import type { MetadataRoute } from "next"

const SITE_URL = "https://gaialog.world"

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      lastModified: new Date(),
      changeFrequency: "hourly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/explorer`,
      lastModified: new Date(),
      changeFrequency: "always",
      priority: 0.9,
    },
  ]
}
