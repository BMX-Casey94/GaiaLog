import type { Metadata } from "next"
import { ExplorerClient } from "@/components/explorer/explorer-client"

export const metadata: Metadata = {
  title: "Data Explorer",
  description:
    "Search and explore live environmental readings — air quality, water levels, seismic activity and more — recorded immutably on the BSV blockchain. Filter by location, data type, or date range.",
  alternates: {
    canonical: "/explorer",
  },
  openGraph: {
    title: "GaiaLog Data Explorer",
    description:
      "Search live environmental readings recorded immutably on the BSV blockchain. Every measurement is independently verifiable on-chain.",
    url: "/explorer",
  },
}

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "GaiaLog Environmental Blockchain Readings",
  description:
    "Continuously updated environmental measurements (air quality, water levels, seismic activity, and advanced metrics) collected from authoritative global providers and recorded immutably on the BSV blockchain.",
  url: "https://gaialog.world/explorer",
  creator: {
    "@type": "Organization",
    name: "GaiaLog",
    url: "https://gaialog.world",
  },
  isAccessibleForFree: true,
  keywords: [
    "environmental data",
    "air quality",
    "water levels",
    "seismic activity",
    "blockchain",
    "BSV",
  ],
}

export default function ExplorerPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ExplorerClient />
    </>
  )
}
