import Link from "next/link"
import { getIndexableLocations } from "@/lib/location-pages"
import { locationToSlug } from "@/lib/location-slug"

/**
 * Server-rendered directory of locations that have their own page.
 *
 * Purpose is twofold: it gives crawlers internal links to the location pages
 * (otherwise they would be reachable only from the sitemap), and it gives a
 * reader a way into the dataset by place rather than only by search.
 *
 * Only locations above the substantial-content threshold are listed, so every
 * link resolves to a page that exists. Linking from reading cards would risk
 * 404s, because the card has no way to know whether a location cleared the
 * threshold.
 *
 * Rendered on the server. If the lookup fails the section renders nothing
 * rather than breaking the explorer page around it.
 */
export async function LocationDirectory({ limit = 24 }: { limit?: number }) {
  let locations: Awaited<ReturnType<typeof getIndexableLocations>> = []
  try {
    locations = await getIndexableLocations(limit)
  } catch (error) {
    console.error(
      'LocationDirectory: lookup failed:',
      error instanceof Error ? error.message : error,
    )
    return null
  }

  if (locations.length === 0) return null

  return (
    <section aria-labelledby="location-directory-heading" className="py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <h2
          id="location-directory-heading"
          className="font-display text-2xl sm:text-3xl font-bold text-white mb-3"
        >
          Browse readings by location
        </h2>
        <p className="text-slate-400 mb-8 max-w-3xl">
          Locations with the most recorded readings. Each page lists the measurements
          taken there, with the transaction ID for every reading so it can be checked
          against the BSV blockchain.
        </p>
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {locations.map((location) => (
            <li key={location.normalizedLocation}>
              <Link
                href={`/location/${locationToSlug(location.normalizedLocation)}`}
                className="block rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-2 text-sm text-slate-300 hover:text-white hover:border-slate-700 transition-colors truncate"
              >
                {location.displayLocation}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
