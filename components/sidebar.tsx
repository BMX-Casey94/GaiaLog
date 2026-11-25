"use client"

import Image from "next/image"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Wind, Droplets, Activity, BarChart3, Home, Settings, Shield, Table, Mail } from "lucide-react"

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
    <div className="flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar">
      <div className="border-b border-sidebar-border p-6">
        <div className="flex items-center gap-3">
          <Image
            src="/gaialog-logo-128.png"
            alt="GaiaLog logo"
            width={32}
            height={32}
            className="rounded-md"
          />
          <div>
            <p className="font-display text-xl font-bold leading-tight text-sidebar-foreground">GaiaLog</p>
            <p className="text-xs text-muted-foreground">Environmental Blockchain Monitor</p>
          </div>
        </div>
      </div>

      <nav aria-label="Dashboard sections" className="flex-1 space-y-1 overflow-y-auto p-4">
        {sidebarItems.map((item) => {
          const Icon = item.icon
          const isActive = activeSection === item.id
          return (
            <Button
              key={item.id}
              variant="ghost"
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "h-10 w-full justify-start gap-3 rounded-lg transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-primary hover:text-sidebar-foreground",
              )}
              onClick={() => onSectionChange(item.id)}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {item.label}
            </Button>
          )
        })}
      </nav>

      <div className="border-t border-sidebar-border p-4">
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          Data recorded immutably on the BSV blockchain.
        </p>
      </div>
    </div>
  )
}
