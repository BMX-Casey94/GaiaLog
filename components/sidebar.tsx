"use client"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Wind, Droplets, Activity, BarChart3, Home, Settings, History, Shield, Table, Mail } from "lucide-react"

interface SidebarProps {
  activeSection: string
  onSectionChange: (section: string) => void
}

const sidebarItems = [
  { id: "overview", label: "Overview", icon: Home },
  { id: "air-quality", label: "Air Quality", icon: Wind },
  { id: "water-levels", label: "Water Levels", icon: Droplets },
  { id: "seismic", label: "Seismic Activity", icon: Activity },
  { id: "advanced", label: "Advanced Metrics", icon: BarChart3 },
  { id: "bsv-blockchain", label: "BSV Blockchain", icon: Shield },
  { id: "data-entries", label: "Data Entries", icon: Table },
  { id: "messages", label: "Messages", icon: Mail },
  { id: "settings", label: "Settings", icon: Settings },
]

export function Sidebar({ activeSection, onSectionChange }: SidebarProps) {
  return (
    <div className="w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
      <div className="p-6 border-b border-sidebar-border">
        <h1 className="text-xl font-bold font-space-grotesk text-sidebar-foreground">GaiaLog</h1>
        <p className="text-sm text-muted-foreground mt-1">Environmental Blockchain Monitor</p>
      </div>

      <nav className="flex-1 p-4 space-y-2">
        {sidebarItems.map((item) => {
          const Icon = item.icon
          return (
            <Button
              key={item.id}
              variant={activeSection === item.id ? "secondary" : "ghost"}
              className={cn(
                "w-full justify-start gap-3 h-10",
                activeSection === item.id && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
              onClick={() => onSectionChange(item.id)}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Button>
          )
        })}
      </nav>
    </div>
  )
}
