"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Calendar, Filter, X, Layers } from "lucide-react"
import { DATA_TYPE_CONFIG } from "./explorer-types"

interface FilterBarProps {
  selectedType: string | null
  setSelectedType: (t: string | null) => void
  dateFrom: string
  setDateFrom: (d: string) => void
  dateTo: string
  setDateTo: (d: string) => void
  showFilters: boolean
  setShowFilters: (v: boolean) => void
}

const inactiveClasses = "border-slate-600/50 text-slate-300 hover:bg-slate-800/40 bg-transparent backdrop-blur-sm"

export function FilterBar({
  selectedType,
  setSelectedType,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  showFilters,
  setShowFilters,
}: FilterBarProps) {
  return (
    <>
      <div className="flex flex-wrap justify-center gap-3 mb-6">
        <Button
          size="sm"
          onClick={() => setSelectedType(null)}
          variant={selectedType === null ? "purple" : "outline"}
          className={selectedType === null ? "" : inactiveClasses}
        >
          <Layers className="h-4 w-4 mr-1.5" />
          All Types
        </Button>
        {Object.entries(DATA_TYPE_CONFIG).map(([key, config]) => {
          const Icon = config.icon
          return (
            <Button
              key={key}
              variant={selectedType === key ? "purple" : "outline"}
              size="sm"
              onClick={() => setSelectedType(selectedType === key ? null : key)}
              className={selectedType === key ? "" : inactiveClasses}
            >
              <Icon className="h-4 w-4 mr-1.5" />
              {config.label}
            </Button>
          )
        })}
        <Button
          variant={showFilters ? "purple" : "outline"}
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          className={showFilters ? "" : inactiveClasses}
        >
          <Filter className="h-4 w-4 mr-1.5" />
          Date Range
        </Button>
      </div>

      {showFilters && (
        <div className="flex flex-wrap justify-center gap-4 mb-6 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-2 bg-black/30 backdrop-blur-sm border border-slate-600/30 rounded-lg px-4 py-2">
            <Calendar className="h-4 w-4 text-slate-400" />
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-40 bg-transparent border-none text-white p-0 h-auto focus-visible:ring-0"
            />
            <span className="text-slate-500">to</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-40 bg-transparent border-none text-white p-0 h-auto focus-visible:ring-0"
            />
          </div>
          {(dateFrom || dateTo) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setDateFrom(''); setDateTo(''); }}
              className="text-slate-400 hover:text-white"
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Clear Dates
            </Button>
          )}
        </div>
      )}
    </>
  )
}
