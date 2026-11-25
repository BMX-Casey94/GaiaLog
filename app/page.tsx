import type { Metadata } from "next"
import { Hero } from "@/components/hero"
import { LiveDashboard } from "@/components/sections/live-dashboard"
import { BlockchainExplorer } from "@/components/sections/blockchain-explorer"
import { DataSources, type InitialProviderSource } from "@/components/sections/data-sources"
import { HowItWorks } from "@/components/sections/how-it-works"
import { WalletFundingStrip } from "@/components/sections/wallet-funding-strip"
import { Footer } from "@/components/sections/footer"
import { HomepageBackdrop } from "@/components/ui/homepage-backdrop"
import { providerConfigs } from "@/lib/provider-registry"
import { DATA_FAMILY_DESCRIPTORS, PROVIDER_DESCRIPTORS } from "@/lib/stream-registry"
import {
  buildOpenGraph,
  buildTwitter,
  ORGANIZATION_ID,
  SITE_LOGO,
  SITE_URL,
  WEBSITE_ID,
} from "@/lib/seo"

const HOME_TITLE = "GaiaLog — Environmental Blockchain Monitoring"
const HOME_DESCRIPTION =
  "Live environmental monitoring across air quality, water levels, seismic activity and more, with every reading permanently recorded on the BSV blockchain for verifiable, tamper-proof history."

export const metadata: Metadata = {
  title: HOME_TITLE,
  description: HOME_DESCRIPTION,
  alternates: {
    canonical: "/",
  },
  openGraph: buildOpenGraph({
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    path: "/",
  }),
  twitter: buildTwitter({
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
  }),
}

const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": WEBSITE_ID,
  name: "GaiaLog",
  url: SITE_URL,
  description:
    "Real-time environmental monitoring with every measurement recorded immutably on the BSV blockchain.",
  publisher: { "@id": ORGANIZATION_ID },
  inLanguage: "en-GB",
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${SITE_URL}/explorer?q={search_term_string}`,
    },
    "query-input": "required name=search_term_string",
  },
}

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": ORGANIZATION_ID,
  name: "GaiaLog",
  url: SITE_URL,
  logo: SITE_LOGO,
  description:
    "GaiaLog records real-time environmental data — air quality, water levels, seismic activity and more — immutably on the BSV blockchain.",
}

function getInitialProviders(): InitialProviderSource[] {
  return Object.values(providerConfigs)
    .filter((cfg) => cfg.enabled && cfg.rolloutEnabled)
    .map((cfg) => {
      const desc = PROVIDER_DESCRIPTORS[cfg.id]
      const primaryFamily = desc?.primaryFamily ?? "advanced_metrics"
      const familyLabel =
        DATA_FAMILY_DESCRIPTORS[primaryFamily as keyof typeof DATA_FAMILY_DESCRIPTORS]?.label ??
        primaryFamily
      return {
        id: cfg.id,
        name: desc?.displayName ?? cfg.id,
        primaryFamily,
        type: familyLabel,
        intervalMs: cfg.cadence.intervalMs ?? 600000,
        coverage: "Global",
        status: cfg.enabled ? "operational" : "disabled",
      }
    })
}

export default function HomePage() {
  const initialProviders = getInitialProviders()

  return (
    <div className="relative min-h-screen bg-gradient-to-b from-[#070312] via-[#0c061d] to-[#04020a] pt-0 pb-20 sm:pb-0">
      <HomepageBackdrop />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
      />
      <div className="relative z-10">
        <Hero initialProviderCount={initialProviders.length} />
        <main>
          <LiveDashboard />
          <WalletFundingStrip />
          <BlockchainExplorer />
          <DataSources initialSources={initialProviders} />
          <HowItWorks />
        </main>
        <Footer />
      </div>
    </div>
  )
}
