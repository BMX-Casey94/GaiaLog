"use client"

import { usePathname } from "next/navigation"
import { BarChart3, Link2, Database, HelpCircle, Home, Search } from "lucide-react"
import { NavBar } from "@/components/ui/tubelight-navbar"

export function Navigation() {
  const pathname = usePathname()

  // The admin dashboard and login screen have their own chrome — the public
  // floating navbar would overlap the dashboard top bar.
  if (pathname?.startsWith("/admin") || pathname?.startsWith("/login")) {
    return null
  }

  const navItems = [
    { name: "Home", url: "/", icon: Home },
    { name: "Data Explorer", url: "/explorer", icon: Search },
    // Use absolute hash URLs so these work from any route (e.g. `/explorer`).
    { name: "Live Alerts", url: "/#monitoring", icon: BarChart3 },
    { name: "Blockchain Explorer", url: "/#blockchain", icon: Link2 },
    { name: "Data Sources", url: "/#data-sources", icon: Database },
    { name: "How It Works", url: "/#how-it-works", icon: HelpCircle },
  ]

  return <NavBar items={navItems} />
}
