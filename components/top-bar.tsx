"use client"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RefreshCw, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { useEnvironmentalData } from "@/hooks/use-environmental-data"

export function TopBar() {
  const { theme, setTheme } = useTheme()
  const { refetch, loading } = useEnvironmentalData()

  return (
    <div className="h-16 border-b border-border bg-background px-6 flex items-center justify-between">
      <div className="flex items-center gap-4">
        <h2 className="text-lg font-semibold font-space-grotesk">Environmental Dashboard</h2>
        <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded-sm">
          <div className="w-2 h-2 bg-green-500 rounded-full mr-2" />
          BSV Connected
        </Badge>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh Data
        </Button>
        <Button variant="outline" size="sm" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}
