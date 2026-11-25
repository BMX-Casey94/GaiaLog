import type { MetadataRoute } from "next"
import { SITE_URL } from "@/lib/seo"

/**
 * `lastModified` is deliberately omitted.
 *
 * The previous implementation used `new Date()`, which Next evaluates once at
 * build time. That value therefore tracked deploy time rather than content
 * change, and would tell crawlers both pages had changed on every deploy. A
 * `lastmod` that is not trustworthy is worse than no `lastmod`: crawlers learn
 * to ignore it. When per-route content timestamps exist, pass real dates here.
 *
 * `changeFrequency` is also omitted for the same reason — Google ignores it,
 * and the readings change far more often than the documents listing them.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: SITE_URL,
      priority: 1,
    },
    {
      url: `${SITE_URL}/explorer`,
      priority: 0.9,
    },
  ]
}
