"use client"

import { useState } from "react"
import { useTheme } from "next-themes"
import { useRouter } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAdminRefresh } from "@/components/admin-refresh"
import { useBlockchain } from "@/components/blockchain-provider"
import { useHasMounted } from "@/hooks/use-has-mounted"
import { cn } from "@/lib/utils"
import { Menu, Moon, RefreshCw, Sun } from "lucide-react"

export function TopBar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { resolvedTheme, setTheme } = useTheme()
  const router = useRouter()
  const { connectionStatus, loading, refresh } = useBlockchain()
  const { refreshAll } = useAdminRefresh()
  const mounted = useHasMounted()
  const [refreshing, setRefreshing] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const connected = connectionStatus?.connected ?? false
  // Distinguish "still checking" from "checked and down": showing a red
  // "offline" badge before the first response has arrived is a false alarm.
  const checking = loading && connectionStatus === null
  const isDark = mounted && resolvedTheme === "dark"

  async function handleRefresh() {
    setRefreshing(true)
    setActionError(null)
    try {
      // Reload the blockchain status here, and ask every mounted panel to
      // reload its own data through the shared refresh counter.
      await Promise.all([refresh(), Promise.resolve(refreshAll())])
    } catch {
      setActionError("Refresh failed. Check that the API is reachable.")
    } finally {
      setRefreshing(false)
    }
  }

  async function handleSignOut() {
    setSigningOut(true)
    setActionError(null)
    try {
      const res = await fetch("/api/auth/sign-out", { method: "POST" })
      if (!res.ok) throw new Error(`Sign-out failed (${res.status})`)
      router.replace("/login")
    } catch {
      setActionError("Sign-out failed. Please try again.")
      setSigningOut(false)
    }
  }

  return (
    <div className="flex h-16 items-center justify-between gap-2 border-b border-border bg-background px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 md:hidden"
          onClick={onMenuClick}
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" aria-hidden />
        </Button>
        <h2 className="truncate font-display text-lg font-semibold">Environmental Dashboard</h2>
        <Badge
          variant="secondary"
          className={cn(
            "hidden rounded-sm sm:inline-flex",
            checking && "bg-yellow-100 text-yellow-900 dark:bg-yellow-900 dark:text-yellow-100",
            !checking && connected && "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
            !checking && !connected && "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
          )}
          title={connectionStatus?.reason ?? undefined}
        >
          <span
            className={cn(
              "mr-2 h-2 w-2 rounded-full",
              checking ? "bg-yellow-500" : connected ? "bg-green-500" : "bg-red-500",
            )}
            aria-hidden
          />
          {checking ? "Checking BSV…" : connected ? "BSV connected" : "BSV offline"}
        </Badge>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {actionError && (
          <span role="alert" className="hidden text-xs text-destructive lg:inline">
            {actionError}
          </span>
        )}
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}>
          <RefreshCw className={cn("h-4 w-4 md:mr-2", refreshing && "animate-spin")} aria-hidden />
          <span className="hidden md:inline">{refreshing ? "Refreshing…" : "Refresh data"}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label={mounted ? (isDark ? "Switch to light theme" : "Switch to dark theme") : "Toggle theme"}
        >
          {mounted ? (
            isDark ? (
              <Sun className="h-4 w-4" aria-hidden />
            ) : (
              <Moon className="h-4 w-4" aria-hidden />
            )
          ) : (
            // Neutral placeholder: the resolved theme is unknown until mount,
            // so rendering an icon here would break hydration.
            <span className="h-4 w-4" aria-hidden />
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={handleSignOut} disabled={signingOut} aria-label="Sign out">
          <span className="text-xs">{signingOut ? "Signing out…" : "Sign out"}</span>
        </Button>
      </div>
    </div>
  )
}
