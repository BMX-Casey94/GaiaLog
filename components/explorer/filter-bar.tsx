"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
  /**
   * Live per-family counts from /api/explorer/stats.
   * - null/undefined: counts not loaded yet — show all tabs (avoid empty flash)
   * - object: hide families with count <= 0 so empty filters never appear
   */
  typeCounts?: Record<string, number> | null
}

const inactiveClasses =
  "border-slate-600/50 text-slate-300 hover:bg-slate-800/40 bg-transparent backdrop-blur-sm"

const ALL_TYPES_VALUE = "all"

export function FilterBar({
  selectedType,
  setSelectedType,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  showFilters,
  setShowFilters,
  typeCounts = null,
}: FilterBarProps) {
  const typeEntries = Object.entries(DATA_TYPE_CONFIG).filter(([key]) => {
    if (typeCounts == null) return true
    return (typeCounts[key] ?? 0) > 0
  })

  const SelectedIcon =
    selectedType && DATA_TYPE_CONFIG[selectedType]
      ? DATA_TYPE_CONFIG[selectedType].icon
      : Layers

  const dateRangePanel = showFilters ? (
    <div className="flex flex-wrap justify-center gap-3 sm:gap-4 mb-6 animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="flex flex-wrap items-center justify-center gap-2 bg-black/30 backdrop-blur-sm border border-slate-600/30 rounded-lg px-3 py-2 sm:px-4 w-full sm:w-auto max-w-lg">
        <Calendar className="h-4 w-4 text-slate-400 shrink-0" />
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="w-[9.5rem] sm:w-40 bg-transparent border-none text-white p-0 h-auto focus-visible:ring-0 text-sm"
        />
        <span className="text-slate-500 text-sm">to</span>
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="w-[9.5rem] sm:w-40 bg-transparent border-none text-white p-0 h-auto focus-visible:ring-0 text-sm"
        />
      </div>
      {(dateFrom || dateTo) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDateFrom("")
            setDateTo("")
          }}
          className="text-slate-400 hover:text-white"
        >
          <X className="h-3.5 w-3.5 mr-1" />
          Clear Dates
        </Button>
      )}
    </div>
  ) : null

  return (
    <>
      {/* Mobile: custom dark type menu + date toggle */}
      <div className="md:hidden flex flex-col gap-3 mb-4 max-w-lg mx-auto w-full">
        <Select
          value={selectedType ?? ALL_TYPES_VALUE}
          onValueChange={(value) =>
            setSelectedType(value === ALL_TYPES_VALUE ? null : value)
          }
        >
          <SelectTrigger
            aria-label="Data type filter"
            className="h-11 w-full rounded-xl border-slate-600/50 bg-black/40 text-slate-100 backdrop-blur-sm focus:ring-purple-500/40 focus:ring-offset-0"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
              <SelectedIcon className="h-4 w-4 shrink-0 text-purple-300" />
              <SelectValue placeholder="All Types" />
            </span>
          </SelectTrigger>
          <SelectContent
            position="popper"
            className="z-[10000] max-h-[min(24rem,60vh)] w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl border-slate-700/70 bg-slate-950/95 text-slate-100 shadow-2xl shadow-purple-950/40 backdrop-blur-md [&_[data-radix-select-viewport]]:h-auto [&_[data-radix-select-viewport]]:max-h-[min(22rem,55vh)]"
          >
            <SelectItem
              value={ALL_TYPES_VALUE}
              className="cursor-pointer rounded-lg py-2.5 pl-8 pr-3 text-slate-100 focus:bg-purple-600/30 focus:text-white data-[highlighted]:bg-purple-600/30 data-[highlighted]:text-white"
            >
              <span className="inline-flex items-center gap-2">
                <Layers className="h-4 w-4 text-purple-300" />
                All Types
              </span>
            </SelectItem>
            {typeEntries.map(([key, config]) => {
              const Icon = config.icon
              return (
                <SelectItem
                  key={key}
                  value={key}
                  className="cursor-pointer rounded-lg py-2.5 pl-8 pr-3 text-slate-100 focus:bg-purple-600/30 focus:text-white data-[highlighted]:bg-purple-600/30 data-[highlighted]:text-white"
                >
                  <span className="inline-flex items-center gap-2">
                    <Icon className="h-4 w-4 text-slate-300" />
                    {config.label}
                  </span>
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>

        <Button
          variant={showFilters ? "purple" : "outline"}
          size="sm"
          onClick={() => setShowFilters(!showFilters)}
          className={`w-full ${showFilters ? "" : inactiveClasses}`}
        >
          <Filter className="h-4 w-4 mr-1.5" />
          Date Range
          {(dateFrom || dateTo) && (
            <span className="ml-1.5 text-xs opacity-80">(active)</span>
          )}
        </Button>
      </div>

      {/* Desktop / tablet: chip row */}
      <div className="hidden md:flex flex-wrap justify-center gap-3 mb-6">
        <Button
          size="sm"
          onClick={() => setSelectedType(null)}
          variant={selectedType === null ? "purple" : "outline"}
          className={selectedType === null ? "" : inactiveClasses}
        >
          <Layers className="h-4 w-4 mr-1.5" />
          All Types
        </Button>
        {typeEntries.map(([key, config]) => {
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

      {dateRangePanel}
    </>
  )
}
