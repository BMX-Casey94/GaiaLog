import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Compass, Home, Search } from "lucide-react"

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-b from-black via-slate-950 to-black">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at center, rgba(88, 28, 135, 0.25) 0%, rgba(59, 7, 100, 0.15) 40%, transparent 75%)`,
        }}
      />
      <div className="relative text-center max-w-lg">
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-slate-800/50 border border-slate-700/40 mb-8">
          <Compass className="h-10 w-10 text-purple-400" />
        </div>
        <h1 className="font-display text-6xl font-bold gradient-heading mb-4">404</h1>
        <h2 className="font-display text-2xl font-semibold text-white mb-3">Page not found</h2>
        <p className="text-slate-400 mb-8">
          The page you are looking for does not exist or has been moved. The data itself is
          still immutable on-chain — it is just not here.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Button asChild variant="purple" size="lg">
            <Link href="/">
              <Home className="mr-2 h-4 w-4" />
              Back to Home
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg" className="border-slate-600 text-slate-300 hover:bg-slate-800 bg-transparent">
            <Link href="/explorer">
              <Search className="mr-2 h-4 w-4" />
              Data Explorer
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
