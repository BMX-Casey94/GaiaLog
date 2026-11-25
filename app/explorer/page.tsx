import type { Metadata } from "next"
import { ExplorerClient } from "@/components/explorer/explorer-client"
import {
  buildOpenGraph,
  buildTwitter,
  ORGANIZATION_ID,
  SITE_URL,
  WEBSITE_ID,
} from "@/lib/seo"

const EXPLORER_TITLE = "Data Explorer"
const EXPLORER_DESCRIPTION =
  "Search and explore live environmental readings — air quality, water levels, seismic activity and more — recorded immutably on the BSV blockchain. Filter by location, data type, or date range."

export const metadata: Metadata = {
  title: EXPLORER_TITLE,
  description: EXPLORER_DESCRIPTION,
  alternates: {
    canonical: "/explorer",
  },
  openGraph: buildOpenGraph({
    title: "GaiaLog Data Explorer",
    description:
      "Search live environmental readings recorded immutably on the BSV blockchain. Every measurement is independently verifiable on-chain.",
    path: "/explorer",
  }),
  twitter: buildTwitter({
    title: "GaiaLog Data Explorer",
    description:
      "Search live environmental readings recorded immutably on the BSV blockchain. Every measurement is independently verifiable on-chain.",
  }),
}

const DATASET_ID = `${SITE_URL}/explorer#dataset`

/**
 * `license` is deliberately absent. The repository's MIT licence covers the
 * software, not the environmental readings, which remain subject to each
 * upstream provider's terms. Claiming MIT over the data would be incorrect and
 * would mislead anyone reusing it.
 */
const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  "@id": DATASET_ID,
  name: "GaiaLog Environmental Blockchain Readings",
  description:
    "Continuously updated environmental measurements (air quality, water levels, seismic activity, and advanced metrics) collected from authoritative global providers and recorded immutably on the BSV blockchain.",
  url: `${SITE_URL}/explorer`,
  creator: { "@id": ORGANIZATION_ID },
  publisher: { "@id": ORGANIZATION_ID },
  isPartOf: { "@id": WEBSITE_ID },
  isAccessibleForFree: true,
  keywords: [
    "environmental data",
    "air quality",
    "water levels",
    "seismic activity",
    "blockchain",
    "BSV",
  ],
  spatialCoverage: {
    "@type": "Place",
    name: "Global",
  },
  variableMeasured: [
    { "@type": "PropertyValue", name: "Air quality index", unitText: "AQI" },
    { "@type": "PropertyValue", name: "Particulate matter PM2.5", unitText: "µg/m³" },
    { "@type": "PropertyValue", name: "Particulate matter PM10", unitText: "µg/m³" },
    { "@type": "PropertyValue", name: "Water level", unitText: "m" },
    { "@type": "PropertyValue", name: "Water temperature", unitText: "°C" },
    { "@type": "PropertyValue", name: "Earthquake magnitude" },
    { "@type": "PropertyValue", name: "Earthquake depth", unitText: "km" },
    { "@type": "PropertyValue", name: "Air temperature", unitText: "°C" },
    { "@type": "PropertyValue", name: "Relative humidity", unitText: "%" },
    { "@type": "PropertyValue", name: "Atmospheric pressure", unitText: "hPa" },
  ],
}

const breadcrumbJsonLd = {
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: SITE_URL,
    },
    {
      "@type": "ListItem",
      position: 2,
      name: "Data Explorer",
      item: `${SITE_URL}/explorer`,
    },
  ],
}

export default function ExplorerPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <ExplorerClient />
    </>
  )
}
