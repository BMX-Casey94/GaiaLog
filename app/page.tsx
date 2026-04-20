import { Hero } from "@/components/hero"
import { LiveDashboard } from "@/components/sections/live-dashboard"
import { BlockchainExplorer } from "@/components/sections/blockchain-explorer"
import { DataSources } from "@/components/sections/data-sources"
import { HowItWorks } from "@/components/sections/how-it-works"
import { Footer } from "@/components/sections/footer"

export default function HomePage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-950 to-black pt-0 pb-20 sm:pb-0">
      <Hero />
      <LiveDashboard />
      <BlockchainExplorer />
      <DataSources />
      <HowItWorks />
      <Footer />
    </div>
  )
}
