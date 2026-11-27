"use client"

import { useState } from "react"
import { AdminRefreshProvider } from "@/components/admin-refresh"
import { BlockchainProvider } from "@/components/blockchain-provider"
import { MainPanel } from "@/components/main-panel"
import { Sidebar } from "@/components/sidebar"
import { TopBar } from "@/components/top-bar"

export function Dashboard() {
  const [activeSection, setActiveSection] = useState("overview")
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <AdminRefreshProvider>
      <BlockchainProvider>
        <div className="flex h-screen bg-background">
          {/* Mobile navigation scrim */}
          {sidebarOpen && (
            <button
              type="button"
              className="fixed inset-0 z-40 cursor-default bg-black/50 md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close navigation"
            />
          )}

          <div
            className={`fixed inset-y-0 left-0 z-50 transition-transform duration-200 md:static md:translate-x-0 ${
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <Sidebar
              activeSection={activeSection}
              onSectionChange={(section) => {
                setActiveSection(section)
                // Selecting a section is the end of the mobile task, so the
                // drawer closes from here rather than from a second callback.
                setSidebarOpen(false)
              }}
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar onMenuClick={() => setSidebarOpen(true)} />
            <MainPanel activeSection={activeSection} />
          </div>
        </div>
      </BlockchainProvider>
    </AdminRefreshProvider>
  )
}
