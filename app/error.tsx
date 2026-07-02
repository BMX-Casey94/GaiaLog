"use client"

import { useEffect } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Home, RotateCcw } from "lucide-react"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Route error boundary caught:", error)
  }, [error])

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-b from-black via-slate-950 to-black">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at center, rgba(127, 29, 29, 0.2) 0%, rgba(59, 7, 100, 0.15) 40%, transparent 75%)`,
        }}
      />
      <div className="relative text-center max-w-lg">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-900/20 border border-red-800/30 mb-8">
          <AlertTriangle className="h-10 w-10 text-red-400" />
        </div>
        <h1 className="font-display text-3xl font-bold text-white mb-3">Something went wrong</h1>
        <p className="text-slate-400 mb-8">
          An unexpected error occurred while loading this page. You can try again, or head back
          to the home page.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button onClick={reset} variant="purple" size="lg">
            <RotateCcw className="mr-2 h-4 w-4" />
            Try Again
          </Button>
          <Button asChild variant="outline" size="lg" className="border-slate-600 text-slate-300 hover:bg-slate-800 bg-transparent">
            <Link href="/">
              <Home className="mr-2 h-4 w-4" />
              Back to Home
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
