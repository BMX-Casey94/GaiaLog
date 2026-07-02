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
    <div className="w-64 h-full bg-sidebar border-r border-sidebar-border flex flex-col">
      <div className="p-6 border-b border-sidebar-border">
        <div className="flex items-center gap-3">
          <Image
            src="/gaialog-logo-128.png"
            alt="GaiaLog logo"
            width={32}
            height={32}
            className="rounded-md"
          />
          <div>
            <h1 className="font-display text-xl font-bold text-sidebar-foreground leading-tight">GaiaLog</h1>
            <p className="text-xs text-muted-foreground">Environmental Blockchain Monitor</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {sidebarItems.map((item) => {
          const Icon = item.icon
          const isActive = activeSection === item.id
          return (
            <Button
              key={item.id}
              variant="ghost"
              className={cn(
                "w-full justify-start gap-3 h-10 rounded-lg transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-primary hover:text-sidebar-foreground",
              )}
              onClick={() => onSectionChange(item.id)}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Button>
          )
        })}
      </nav>

      <div className="p-4 border-t border-sidebar-border">
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Data recorded immutably on the BSV blockchain.
        </p>
      </div>
    </div>
  )
}
