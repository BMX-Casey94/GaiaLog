import type { MetadataRoute } from "next"
import { SITE_URL } from "@/lib/seo"
import { getIndexableLocations } from "@/lib/location-pages"
import { locationToSlug } from "@/lib/location-slug"

/**
 * Sitemap.
 *
 * Location pages are included because they are the only server-rendered pages
 * that expose individual readings. Roughly 18,000 locations clear the
 * substantial-content threshold, so the total stays inside the protocol's
 * 50,000-URL / 50 MB per-file limit and no sitemap index is required. If the
 * threshold is ever lowered far enough to approach that limit, split this into
 * a sitemap index with `generateSitemaps`.
 *
 * `lastModified` is omitted on the static entries: a build-time timestamp
 * tracks deploys rather than content changes, and crawlers learn to ignore a
 * `lastmod` they cannot trust. Location entries do carry a real timestamp,
 * because `last_reading_ts` genuinely reflects when the page content moved.
 *
 * A lookup failure falls back to the static entries rather than erroring. A
 * sitemap missing its location URLs is a degraded result; a sitemap returning
 * 500 is worse, because crawlers treat repeated failures as the file being
 * gone.
 */
export const dynamic = "force-dynamic"

const STATIC_ENTRIES: MetadataRoute.Sitemap = [
  { url: SITE_URL, priority: 1 },
  { url: `${SITE_URL}/explorer`, priority: 0.9 },
]

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let locationEntries: MetadataRoute.Sitemap = []
  try {
    const locations = await getIndexableLocations()
    locationEntries = locations.map((location) => ({
      url: `${SITE_URL}/location/${locationToSlug(location.normalizedLocation)}`,
      lastModified: new Date(location.lastReading),
      priority: 0.6,
    }))
  } catch (error) {
    console.error(
      'sitemap: falling back to static entries, location lookup failed:',
      error instanceof Error ? error.message : error,
    )
  }

  return [...STATIC_ENTRIES, ...locationEntries]
}
