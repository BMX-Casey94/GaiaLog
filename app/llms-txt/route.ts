import { providerConfigs } from "@/lib/provider-registry"
import { PROVIDER_DESCRIPTORS, DATA_FAMILY_DESCRIPTORS } from "@/lib/stream-registry"
import { SITE_URL } from "@/lib/seo"

export const dynamic = "force-static"
export const revalidate = 3600

/**
 * `llms.txt` — a plain-text summary aimed at LLM crawlers and retrieval
 * pipelines, which generally do not execute JavaScript and therefore cannot
 * see the readings the explorer loads client-side.
 *
 * Served at `/llms.txt` via a rewrite in `next.config.mjs`. The route folder is
 * `app/llms-txt` because a literal `app/llms.txt` directory makes Next.js treat
 * the segment as a Pages Router page and the build fails looking for
 * `/_document`.
 *
 * The provider list is generated from the same registry the app uses, so it
 * cannot disagree with what the site actually ingests. It is emitted as static
 * text at build time and revalidated hourly.
 */
export function GET() {
  const enabled = Object.values(providerConfigs)
    .filter((cfg) => cfg.enabled && cfg.rolloutEnabled)
    .map((cfg) => {
      const desc = PROVIDER_DESCRIPTORS[cfg.id]
      const family = desc?.primaryFamily
      const familyLabel =
        family && DATA_FAMILY_DESCRIPTORS[family as keyof typeof DATA_FAMILY_DESCRIPTORS]
          ? DATA_FAMILY_DESCRIPTORS[family as keyof typeof DATA_FAMILY_DESCRIPTORS].label
          : "Advanced Metrics"
      return {
        name: desc?.displayName ?? cfg.id,
        family: familyLabel,
        cadenceMinutes: Math.round((cfg.cadence.intervalMs ?? 600000) / 60000),
      }
    })
    .sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name))

  // De-duplicate family labels so the summary reads as a plain list of the
  // measurement domains actually covered.
  const families = Array.from(new Set(enabled.map((p) => p.family))).sort()

  const providerLines = enabled
    .map(
      (p) =>
        `- ${p.name} — ${p.family} — every ${p.cadenceMinutes} ${
          p.cadenceMinutes === 1 ? "minute" : "minutes"
        }`,
    )
    .join("\n")

  const body = `# GaiaLog

> GaiaLog is an environmental monitoring service that records air quality, water
> level, seismic and related measurements to the BSV blockchain. Each reading is
> published as a blockchain transaction so the recorded history can be checked
> against the chain rather than taken on trust.

## What this site is

- A live dashboard of environmental readings, at ${SITE_URL}
- A searchable index of every reading published to the chain, at ${SITE_URL}/explorer
- An open, machine-readable data surface described below

## Data coverage

Measurement domains currently published: ${families.join(", ")}.

Active upstream providers:

${providerLines}

Readings are collected from the upstream provider, normalised to a common
payload, then written on-chain. Upstream providers retain their own terms and
attribution requirements; GaiaLog does not relicense their data.

## How verification works

Every reading is written in a BSV transaction. The payload can be decoded
independently with the GaiaLog WhatsOnChain decoder plugin, which turns a
transaction ID into the original reading. A reading and its on-chain record can
therefore be compared without trusting this site.

## Machine-readable endpoints

All endpoints return JSON and are free to read.

- ${SITE_URL}/api/explorer/search — search readings by location, data type or date range
- ${SITE_URL}/api/explorer/latest-readings — most recent readings
- ${SITE_URL}/api/explorer/stats — aggregate counts by data family
- ${SITE_URL}/api/explorer/locations — location suggestions
- ${SITE_URL}/api/explorer/priority-alerts — current high-severity readings
- ${SITE_URL}/api/air-quality/latest — latest air quality readings
- ${SITE_URL}/api/water-levels/latest — latest water level readings
- ${SITE_URL}/api/seismic/latest — latest seismic readings
- ${SITE_URL}/api/advanced-metrics/latest — latest advanced metric readings

Internal and administrative endpoints are documented nowhere and are not part of
this surface.

## Software licence

The GaiaLog application source is MIT licensed. That licence covers the
software, not the environmental readings, which remain subject to each upstream
provider's terms.

## Contact

Use the contact form in the site footer.
`

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  })
}
