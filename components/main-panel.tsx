"use client"

import { OverviewPanel } from "@/components/panels/overview-panel"
import { AirQualityPanel } from "@/components/panels/air-quality-panel"
import { WaterLevelsPanel } from "@/components/panels/water-levels-panel"
import { SeismicPanel } from "@/components/panels/seismic-panel"
import { AdvancedPanel } from "@/components/panels/advanced-panel"
import { BSVBlockchainPanel } from "@/components/panels/bsv-blockchain-panel"
import { DataEntriesPanel } from "@/components/panels/data-entries-panel"
import { SettingsPanel } from "@/components/panels/settings-panel"
import { MessagesPanel } from "@/components/panels/messages-panel"

interface MainPanelProps {
  activeSection: string
}

export function MainPanel({ activeSection }: MainPanelProps) {
  const renderPanel = () => {
    switch (activeSection) {
      case "overview":
        return <OverviewPanel />
      case "air-quality":
        return <AirQualityPanel />
      case "water-levels":
        return <WaterLevelsPanel />
      case "seismic":
        return <SeismicPanel />
      case "advanced":
        return <AdvancedPanel />
      case "bsv-blockchain":
        return <BSVBlockchainPanel />
      case "data-entries":
        return <DataEntriesPanel />
      case "messages":
        return <MessagesPanel />
      case "settings":
        return <SettingsPanel />
      default:
        return <OverviewPanel />
    }
  }

  return <div className="flex-1 overflow-auto bg-background">{renderPanel()}</div>
}
