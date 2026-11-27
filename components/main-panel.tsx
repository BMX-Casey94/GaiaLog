"use client"

import type { ReactNode } from "react"
import { AirQualityPanel } from "@/components/panels/air-quality-panel"
import { AdvancedPanel } from "@/components/panels/advanced-panel"
import { BSVBlockchainPanel } from "@/components/panels/bsv-blockchain-panel"
import { DataEntriesPanel } from "@/components/panels/data-entries-panel"
import { MessagesPanel } from "@/components/panels/messages-panel"
import { OverviewPanel } from "@/components/panels/overview-panel"
import { SeismicPanel } from "@/components/panels/seismic-panel"
import { SettingsPanel } from "@/components/panels/settings-panel"
import { WaterLevelsPanel } from "@/components/panels/water-levels-panel"

interface MainPanelProps {
  activeSection: string
}

export function MainPanel({ activeSection }: MainPanelProps) {
  const panels: Record<string, ReactNode> = {
    overview: <OverviewPanel />,
    "air-quality": <AirQualityPanel />,
    "water-levels": <WaterLevelsPanel />,
    seismic: <SeismicPanel />,
    advanced: <AdvancedPanel />,
    "bsv-blockchain": <BSVBlockchainPanel />,
    "data-entries": <DataEntriesPanel />,
    messages: <MessagesPanel />,
    settings: <SettingsPanel />,
  }

  // Only the active panel is mounted, so switching sections stops its polling
  // interval and its in-flight requests rather than leaking them in the
  // background.
  return (
    <div className="flex-1 overflow-auto bg-background">
      {panels[activeSection] ?? <OverviewPanel />}
    </div>
  )
}
