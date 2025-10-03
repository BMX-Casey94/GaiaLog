import { GlowCard } from "@/components/ui/spotlight-card"
import { Button } from "@/components/ui/button"
import { Database, Shield, Globe, Search, BarChart3, Clock } from "lucide-react"

export function Features() {
  return (
    <div className="py-24 bg-slate-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* What we monitor */}
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold text-white mb-4">Comprehensive Environmental Monitoring</h2>
          <p className="text-xl text-slate-300 max-w-3xl mx-auto">
            We continuously collect and verify environmental data from multiple sources, storing each measurement
            immutably on the BSV blockchain for complete transparency.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 mb-24">
          <GlowCard glowColor="blue" customSize>
            <Database className="h-8 w-8 text-blue-400 mb-2" />
            <div className="text-white font-semibold text-lg mb-2">Air Quality Data</div>
            <div className="text-slate-300 text-sm">
              Real-time air quality measurements including PM2.5, PM10, CO2, and pollutant levels
            </div>
          </GlowCard>

          <GlowCard glowColor="green" customSize>
            <Globe className="h-8 w-8 text-green-400 mb-2" />
            <div className="text-white font-semibold text-lg mb-2">Water Quality</div>
            <div className="text-slate-300 text-sm">
              Water level monitoring, pH levels, and contamination detection from environmental sensors
            </div>
          </GlowCard>

          <GlowCard glowColor="purple" customSize>
            <BarChart3 className="h-8 w-8 text-purple-400 mb-2" />
            <div className="text-white font-semibold text-lg mb-2">Seismic Activity</div>
            <div className="text-slate-300 text-sm">
              Earthquake monitoring and geological activity tracking from global seismic networks
            </div>
          </GlowCard>
        </div>

        {/* Blockchain verification */}
        <div className="bg-gradient-to-r from-purple-900/20 to-pink-900/20 rounded-2xl p-12 mb-24 border border-purple-800/30">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h3 className="text-3xl font-bold text-white mb-6">Blockchain-Verified Transparency</h3>
              <p className="text-slate-300 mb-6 leading-relaxed">
                Every environmental measurement is cryptographically signed and recorded on the BSV blockchain. This
                creates an immutable audit trail that anyone can verify, ensuring data integrity and preventing
                manipulation.
              </p>
              <div className="space-y-4">
                <div className="flex items-center space-x-3">
                  <Shield className="h-5 w-5 text-green-400" />
                  <span className="text-slate-300">Cryptographically secured data</span>
                </div>
                <div className="flex items-center space-x-3">
                  <Clock className="h-5 w-5 text-blue-400" />
                  <span className="text-slate-300">Real-time blockchain recording</span>
                </div>
                <div className="flex items-center space-x-3">
                  <Search className="h-5 w-5 text-purple-400" />
                  <span className="text-slate-300">Publicly auditable transactions</span>
                </div>
              </div>
            </div>

            <div className="bg-slate-800/50 rounded-lg p-6 border border-slate-700">
              <div className="text-sm text-slate-400 mb-2">Latest Transaction</div>
              <div className="font-mono text-xs text-slate-300 bg-slate-900 p-3 rounded border">
                TXID: 7a8b9c2d3e4f5g6h7i8j9k0l1m2n3o4p5q6r7s8t9u0v1w2x3y4z5a6b7c8d9e0f
              </div>
              <div className="text-xs text-slate-400 mt-2">Air Quality • PM2.5: 42 μg/m³ • Recorded 3 minutes ago</div>
              <Button variant="outline" size="sm" className="mt-4 border-slate-600 text-slate-300 bg-transparent">
                View on Blockchain Explorer
              </Button>
            </div>
          </div>
        </div>

        {/* How to verify */}
        <div className="text-center">
          <h3 className="text-3xl font-bold text-white mb-6">Verify Our Data Yourself</h3>
          <p className="text-xl text-slate-300 mb-8 max-w-3xl mx-auto">
            Don't just trust us - verify every measurement yourself. Each data point includes a blockchain transaction
            ID that you can look up on any BSV blockchain explorer.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="bg-slate-800 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-4">
                <span className="text-purple-400 font-bold">1</span>
              </div>
              <h4 className="text-white font-semibold mb-2">Find Transaction ID</h4>
              <p className="text-slate-400 text-sm">Every data point displays its unique blockchain transaction ID</p>
            </div>

            <div className="text-center">
              <div className="bg-slate-800 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-4">
                <span className="text-purple-400 font-bold">2</span>
              </div>
              <h4 className="text-white font-semibold mb-2">Use Block Explorer</h4>
              <p className="text-slate-400 text-sm">Search the TXID on any BSV blockchain explorer like WhatsOnChain</p>
            </div>

            <div className="text-center">
              <div className="bg-slate-800 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-4">
                <span className="text-purple-400 font-bold">3</span>
              </div>
              <h4 className="text-white font-semibold mb-2">Verify Data</h4>
              <p className="text-slate-400 text-sm">Compare the blockchain record with our displayed data</p>
            </div>
          </div>

          <Button size="lg" className="mt-8 bg-purple-600 hover:bg-purple-700">
            Start Exploring Data
          </Button>
        </div>
      </div>
    </div>
  )
}
