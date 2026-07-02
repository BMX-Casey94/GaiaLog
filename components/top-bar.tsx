"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RefreshCw, Moon, Sun, Menu, LogOut } from "lucide-react"
import { useTheme } from "next-themes"
import { useRouter } from "next/navigation"
import { useEnvironmentalData } from "@/hooks/use-environmental-data"
import { useBlockchain } from "@/hooks/use-blockchain"

export function TopBar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { theme, setTheme } = useTheme()
  const router = useRouter()
  const { refetch, loading } = useEnvironmentalData()
  const { connectionStatus } = useBlockchain()

  const connected = connectionStatus?.connected ?? false

  async function signOut() {
    try {
      await fetch("/api/auth/sign-out", { method: "POST" })
    } finally {
      router.replace("/login")
    }
  }

  return (
    <div className="h-16 border-b border-border bg-background px-4 md:px-6 flex items-center justify-between gap-2">
      <div className="flex items-center gap-3 min-w-0">
        <Button variant="ghost" size="sm" className="md:hidden shrink-0" onClick={onMenuClick} aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </Button>
        <h2 className="font-display text-lg font-semibold truncate">Environmental Dashboard</h2>
        <Badge
          variant="secondary"
          className={`hidden sm:inline-flex rounded-sm ${
            connected
              ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
              : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
          }`}
        >
          <div className={`w-2 h-2 rounded-full mr-2 ${connected ? "bg-green-500" : "bg-red-500"}`} />
          {connected ? "BSV Connected" : "BSV Offline"}
        </Badge>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={`h-4 w-4 md:mr-2 ${loading ? "animate-spin" : ""}`} />
          <span className="hidden md:inline">Refresh Data</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <Button variant="outline" size="sm" onClick={signOut} aria-label="Sign out">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
