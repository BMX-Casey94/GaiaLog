"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ExternalLink, X, Server } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const DISMISS_KEY = "gaialog_node_explorer_promo_dismissed_v1"

export function NodeExplorerPromoBar({
  className,
}: {
  className?: string
}) {
  const [dismissed, setDismissed] = useState(false)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1")
    } catch {
      // Ignore storage errors (privacy mode, blocked access, etc.)
    }
  }, [])

  const onDismiss = () => {
    setDismissed(true)
    try {
      window.localStorage.setItem(DISMISS_KEY, "1")
    } catch {
      // Ignore storage errors (privacy mode, blocked access, etc.)
    }
  }

  // Avoid hydration mismatch if storage state differs.
  if (!hydrated || dismissed) return null

  return (
    <div
      className={cn(
        // Mobile: sit above the bottom nav bar (which is fixed + has margin-bottom).
        // Desktop: stick to the page bottom.
        "fixed left-1/2 w-[min(95vw,42rem)] -translate-x-1/2 rounded-xl border border-slate-700/60 bg-slate-950/80 shadow-2xl backdrop-blur-md z-40",
        "bottom-[calc(env(safe-area-inset-bottom)+5.75rem)] sm:inset-x-0 sm:bottom-0 sm:left-0 sm:w-auto sm:translate-x-0 sm:rounded-none sm:border-x-0 sm:shadow-none sm:border-t",
        className,
      )}
      style={{
        paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)",
      }}
      role="region"
      aria-label="Gaia Explorer promotion"
    >
      <div className="mx-auto flex w-full max-w-7xl items-center gap-2.5 px-3 pt-2 sm:items-center sm:gap-4 sm:px-6 sm:pt-3 lg:px-8">
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-slate-700/60 bg-slate-900/60 sm:h-9 sm:w-9">
          <Server className="h-4 w-4 text-purple-300" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="whitespace-normal text-xs font-semibold leading-tight text-white sm:text-sm sm:leading-normal">
            Prefer a node-style BSV explorer?
          </p>
          <p className="hidden text-xs leading-relaxed text-slate-300 sm:block">
            Open Gaia Explorer for transactions, blocks, and network intelligence.
          </p>
        </div>

        <div className="flex flex-shrink-0 items-center gap-1.5 sm:gap-2">
          <Button asChild size="sm" variant="purple" className="h-9 px-3">
            <Link
              href="https://gaia-explorer.com/?utm_source=gaialog&utm_medium=sticky_bar&utm_campaign=explorer_promo"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="hidden sm:inline">Open Gaia Explorer</span>
              <span className="sm:hidden">Open</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          </Button>

          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700/60 bg-slate-900/40 text-slate-300 transition-colors hover:bg-slate-800/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-500/60"
            aria-label="Dismiss promotion"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

