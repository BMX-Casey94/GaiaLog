import type { Metadata } from "next"
import { Hero } from "@/components/hero"
import { LiveDashboard } from "@/components/sections/live-dashboard"
import { BlockchainExplorer } from "@/components/sections/blockchain-explorer"
import { DataSources } from "@/components/sections/data-sources"
import { HowItWorks } from "@/components/sections/how-it-works"
import { Footer } from "@/components/sections/footer"

export const metadata: Metadata = {
  title: "GaiaLog — Environmental Blockchain Monitoring",
  description:
    "Live environmental monitoring across air quality, water levels, seismic activity and more, with every reading permanently recorded on the BSV blockchain for verifiable, tamper-proof history.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "GaiaLog — Environmental Blockchain Monitoring",
    description:
      "Live environmental monitoring with every reading permanently recorded on the BSV blockchain.",
    url: "https://gaialog.world",
  },
}

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "GaiaLog",
  url: "https://gaialog.world",
  description:
    "Real-time environmental monitoring with every measurement recorded immutably on the BSV blockchain.",
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: "https://gaialog.world/explorer?q={search_term_string}",
    },
    "query-input": "required name=search_term_string",
  },
}

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "GaiaLog",
  url: "https://gaialog.world",
  logo: "https://gaialog.world/gaialog-logo-128.png",
  description:
    "GaiaLog records real-time environmental data — air quality, water levels, seismic activity and more — immutably on the BSV blockchain.",
}

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black pt-0 pb-20 sm:pb-0">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <Hero />
      <LiveDashboard />
      <BlockchainExplorer />
      <DataSources />
      <HowItWorks />
      <Footer />
    </div>
  )
}
