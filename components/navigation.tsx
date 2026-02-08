"use client"

import { BarChart3, Link2, Database, HelpCircle, Home, Search } from "lucide-react"
import { NavBar } from "@/components/ui/tubelight-navbar"

export function Navigation() {
  const navItems = [
    { name: "Home", url: "/", icon: Home },
    { name: "Data Explorer", url: "/explorer", icon: Search },
    // Use absolute hash URLs so these work from any route (e.g. `/explorer`).
    { name: "Live Alerts", url: "/#monitoring", icon: BarChart3 },
    { name: "Blockchain Explorer", url: "/#blockchain", icon: Link2 },
    { name: "Data Sources", url: "/#data-sources", icon: Database },
    { name: "How It Works", url: "/#how-it-works", icon: HelpCircle },
  ]

  return (
    <>
      <NavBar items={navItems} />
    </>
  )
}
