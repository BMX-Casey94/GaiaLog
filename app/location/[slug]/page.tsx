import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { Footer } from "@/components/sections/footer"
import { locationToSlug, slugToLocation } from "@/lib/location-slug"
import { getLocationPage, getLocationReadings, MIN_READINGS_FOR_PAGE } from "@/lib/location-pages"
import {
  describeCoverage,
  formatReadingTime,
  pickDisplayMetrics,
} from "@/lib/location-format"
import {
  SITE_NAME,
  SITE_URL,
  ORGANIZATION_ID,
  WEBSITE_ID,
  buildOpenGraph,
  buildTwitter,
} from "@/lib/seo"

/**
 * Rendered per request: the underlying data changes continuously and the route
 * is parameterised on a value not known at build time.
 *
 * `dynamic = "force-dynamic"` is deliberately NOT set. It is unnecessary — the
 * page reads request params and uncached database rows, so Next treats it as
 * dynamic regardless — and it caused `notFound()` to return HTTP 200 instead of
 * 404, because combined with the root `app/loading.tsx` Suspense boundary the
 * response was flushed before the status could be set.
 */

const WOC_BASE =
  process.env.BSV_NETWORK === "mainnet"
    ? "https://whatsonchain.com"
    : "https://test.whatsonchain.com"

interface PageProps {
  params: Promise<{ slug: string }>
}

function resolve(rawSlug: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawSlug)
  } catch {
    return null
  }
  return slugToLocation(decoded)
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const normalized = resolve(slug)
  const page = normalized ? await getLocationPage(normalized) : null

  // Throw the 404 from here rather than only from the page component, so the
  // status is decided as early as possible.
  //
  // This does NOT fully fix the soft 404. Measured on Next 15.5.12: an unmatched
  // URL (`/nope-xyz`) returns 404, but a matched dynamic route that calls
  // `notFound()` returns 200 with the not-found body. Removing every
  // `loading.tsx` did not change that, so the cause is not a Suspense boundary
  // flushing early — Next begins streaming the dynamic route before this code
  // runs, and the status is already committed by the time the throw happens.
  //
  // The body is the not-found page and carries `noindex`, so nothing wrong is
  // indexed. Malformed slugs are rejected in middleware, where a real 404 is
  // possible (see `middleware.ts`). A well-formed slug for a location below the
  // publication threshold therefore remains a 200 + noindex.
  if (!page) notFound()

  const title = `${page.displayLocation} environmental readings`
  const families = page.families.map((f) => f.label).join(", ")
  const description =
    `${page.totalRecorded.toLocaleString("en-GB")} environmental readings recorded for ` +
    `${page.displayLocation}${families ? ` (${families})` : ""}, ` +
    `published to the BSV blockchain. Every reading is independently verifiable on-chain.`

  return {
    title,
    description,
    alternates: {
      canonical: `/location/${locationToSlug(page.normalizedLocation)}`,
    },
    openGraph: buildOpenGraph({ title, description, path: `/location/${locationToSlug(page.normalizedLocation)}` }),
    twitter: buildTwitter({ title, description }),
  }
}

export default async function LocationPage({ params }: PageProps) {
  const { slug } = await params
  const normalized = resolve(slug)
  if (!normalized) notFound()

  const page = await getLocationPage(normalized)
  if (!page) notFound()

  const readings = await getLocationReadings(normalized, 25)
  const canonical = `${SITE_URL}/location/${locationToSlug(page.normalizedLocation)}`
  const coverage = describeCoverage(page.firstReading, page.lastReading)

  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    "@id": `${canonical}#dataset`,
    name: `Environmental readings for ${page.displayLocation}`,
    description:
      `Environmental measurements recorded for ${page.displayLocation} and published ` +
      `immutably to the BSV blockchain. Covers ${page.families.map((f) => f.label).join(", ") || "multiple data families"}.`,
    url: canonical,
    creator: { "@id": ORGANIZATION_ID },
    publisher: { "@id": ORGANIZATION_ID },
    isPartOf: { "@id": WEBSITE_ID },
    isAccessibleForFree: true,
    temporalCoverage:
      page.firstReading && page.lastReading
        ? `${page.firstReading}/${page.lastReading}`
        : undefined,
    spatialCoverage:
      page.lat != null && page.lon != null
        ? {
            "@type": "Place",
            name: page.displayLocation,
            geo: {
              "@type": "GeoCoordinates",
              latitude: page.lat,
              longitude: page.lon,
            },
          }
        : { "@type": "Place", name: page.displayLocation },
  }

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE_URL },
      { "@type": "ListItem", position: 2, name: "Data Explorer", item: `${SITE_URL}/explorer` },
      { "@type": "ListItem", position: 3, name: page.displayLocation, item: canonical },
    ],
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black pb-24 pt-28 sm:pt-32">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      <main className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="mb-6 text-sm text-slate-400">
          <ol className="flex flex-wrap items-center gap-2">
            <li>
              <Link href="/" className="hover:text-white transition-colors">
                Home
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <Link href="/explorer" className="hover:text-white transition-colors">
                Data Explorer
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li className="text-slate-300">{page.displayLocation}</li>
          </ol>
        </nav>

        <h1 className="font-display text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-white mb-4">
          Environmental readings for {page.displayLocation}
        </h1>

        <p className="text-slate-300 leading-relaxed mb-8 max-w-3xl">
          GaiaLog has recorded{" "}
          <strong className="text-white">{page.totalRecorded.toLocaleString("en-GB")}</strong>{" "}
          environmental readings for {page.displayLocation}
          {page.families.length > 0 ? (
            <>
              , covering{" "}
              {page.families.map((f, i) => (
                <span key={f.family}>
                  {i > 0 && (i === page.families.length - 1 ? " and " : ", ")}
                  {f.label.toLowerCase()}
                </span>
              ))}
            </>
          ) : null}
          . Each reading is written to the BSV blockchain as it is collected, so the
          record can be checked against the chain rather than taken on trust.
        </p>

        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-12">
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <dt className="text-xs uppercase tracking-wide text-slate-400">Readings recorded</dt>
            <dd className="mt-1 text-2xl font-semibold text-white">
              {page.totalRecorded.toLocaleString("en-GB")}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <dt className="text-xs uppercase tracking-wide text-slate-400">Data families</dt>
            <dd className="mt-1 text-2xl font-semibold text-white">{page.families.length}</dd>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <dt className="text-xs uppercase tracking-wide text-slate-400">Latest reading</dt>
            <dd className="mt-1 text-sm font-medium text-white">
              {formatReadingTime(page.lastReading)}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <dt className="text-xs uppercase tracking-wide text-slate-400">Index window</dt>
            <dd className="mt-1 text-sm font-medium text-white">{coverage}</dd>
          </div>
        </dl>

        {page.lat != null && page.lon != null && (
          <p className="text-sm text-slate-400 mb-8">
            Approximate coordinates{" "}
            <span className="text-slate-200">
              {page.lat.toFixed(4)}, {page.lon.toFixed(4)}
            </span>
            . Readings are attributed to this location by the upstream provider.
          </p>
        )}

        <section aria-labelledby="families-heading" className="mb-12">
          <h2 id="families-heading" className="font-display text-2xl font-bold text-white mb-4">
            What is measured here
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {page.families.map((family) => (
              <li
                key={family.family}
                className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/30 px-4 py-3"
              >
                <span className="text-slate-200">{family.label}</span>
                <span className="text-sm text-slate-400">
                  {family.count.toLocaleString("en-GB")} readings
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="recent-heading">
          <h2 id="recent-heading" className="font-display text-2xl font-bold text-white mb-4">
            Most recent readings
          </h2>
          <p className="text-sm text-slate-400 mb-6">
            The latest {readings.length} readings held in the index. Older rows are pruned
            from the local index to control storage; every one remains permanently on the
            BSV chain and can be re-indexed on demand.
          </p>

          <ol className="space-y-3">
            {readings.map((reading) => {
              const metrics = pickDisplayMetrics(reading.metrics, 4, reading.dataFamily)
              return (
                <li
                  key={reading.txid}
                  className="rounded-xl border border-slate-800 bg-slate-900/30 p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                    <span className="font-medium text-white">{reading.familyLabel}</span>
                    <time dateTime={reading.readingTs} className="text-sm text-slate-400">
                      {formatReadingTime(reading.readingTs)}
                    </time>
                  </div>

                  {metrics.length > 0 && (
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4 mb-3">
                      {metrics.map((metric) => (
                        <div key={metric.label}>
                          <dt className="text-xs text-slate-400">{metric.label}</dt>
                          <dd className="text-sm font-medium text-slate-100">{metric.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}

                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    <span className="font-mono break-all">{reading.txid}</span>
                    {reading.confirmed && reading.blockHeight > 0 && (
                      <span className="text-emerald-500">Block {reading.blockHeight}</span>
                    )}
                    <a
                      href={`${WOC_BASE}/tx/${reading.txid.toLowerCase()}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-slate-300 transition-colors"
                    >
                      Verify on-chain
                    </a>
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        <p className="mt-10 text-sm text-slate-400">
          Browse every recording location in the{" "}
          <Link href="/explorer" className="underline hover:text-white transition-colors">
            Data Explorer
          </Link>
          . Locations with fewer than {MIN_READINGS_FOR_PAGE} recordings are not published
          as standalone pages.
        </p>
      </main>

      <Footer />
    </div>
  )
}
