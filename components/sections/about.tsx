"use client"

import { GlowCard } from "@/components/ui/spotlight-card"
import { ArrowRight, Database, Shield, Globe } from "lucide-react"

export function About() {
  return (
    <section id="about" className="py-20 px-4 sm:px-6 lg:px-8 relative">
      <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-slate-900/20 to-slate-950/50 pointer-events-none"></div>
      <div className="relative z-10">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">How GaiaLog Works</h2>
            <p className="text-lg text-slate-400 max-w-2xl mx-auto">
              A simple, transparent process that ensures environmental data integrity through blockchain technology.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-16">
            <div className="text-center">
              <div className="w-16 h-16 bg-blue-600/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <Globe className="h-8 w-8 text-blue-400" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">Data Collection</h3>
              <p className="text-sm text-slate-400">
                Environmental sensors and APIs provide real-time data every 15-60 minutes
              </p>
            </div>

            <div className="text-center">
              <div className="w-16 h-16 bg-slate-950/40 rounded-full flex items-center justify-center mx-auto mb-4">
                <Database className="h-8 w-8 text-purple-400" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">GaiaLog Processing</h3>
              <p className="text-sm text-slate-400">Data is validated, formatted, and prepared for blockchain storage</p>
            </div>

            <div className="text-center">
              <div className="w-16 h-16 bg-green-600/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <Shield className="h-8 w-8 text-green-400" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">BSV Blockchain</h3>
              <p className="text-sm text-slate-400">
                Immutable storage with cryptographic verification and public auditability
              </p>
            </div>

            <div className="text-center">
              <div className="w-16 h-16 bg-orange-600/20 rounded-full flex items-center justify-center mx-auto mb-4">
                <ArrowRight className="h-8 w-8 text-orange-400" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">Dashboard Display</h3>
              <p className="text-sm text-slate-400">Real-time visualisation with blockchain transaction references</p>
            </div>
          </div>

          <GlowCard glowColor="purple" customSize className="max-w-4xl mx-auto">
            <h3 className="text-xl font-semibold text-white mb-4 text-center">
              Why Blockchain for Environmental Data?
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center">
              <div>
                <h4 className="font-medium text-purple-400 mb-2">Immutability</h4>
                <p className="text-sm text-slate-400">Data cannot be altered or deleted once recorded</p>
              </div>
              <div>
                <h4 className="font-medium text-blue-400 mb-2">Transparency</h4>
                <p className="text-sm text-slate-400">All measurements are publicly verifiable</p>
              </div>
              <div>
                <h4 className="font-medium text-green-400 mb-2">Trust</h4>
                <p className="text-sm text-slate-400">No single point of failure or data manipulation</p>
              </div>
            </div>
          </GlowCard>
        </div>
      </div>
    </section>
  )
}
