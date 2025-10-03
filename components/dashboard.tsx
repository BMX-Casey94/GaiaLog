"use client"

import { useState } from "react"
import { Sidebar } from "@/components/sidebar"
import { MainPanel } from "@/components/main-panel"
import { TopBar } from "@/components/top-bar"

export function Dashboard() {
  const [activeSection, setActiveSection] = useState("overview")

  return (
    <div className="flex h-screen bg-background">
      <Sidebar activeSection={activeSection} onSectionChange={setActiveSection} />
      <div className="flex-1 flex flex-col">
        <TopBar />
        <MainPanel activeSection={activeSection} />
      </div>
    </div>
  )
}
