"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Calendar, ChevronDown, Filter, X, Layers } from "lucide-react"
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

const selectClasses =
  "w-full appearance-none rounded-lg border border-slate-600/50 bg-black/40 backdrop-blur-sm " +
  "px-3 py-2.5 pr-10 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-purple-500/40"

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

  const selectedLabel =
    selectedType == null
      ? "All Types"
      : DATA_TYPE_CONFIG[selectedType]?.label || selectedType

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
      {/* Mobile: compact type select + date toggle (avoids a wall of chips) */}
      <div className="md:hidden flex flex-col gap-3 mb-4 max-w-lg mx-auto w-full">
        <div className="relative">
          <label htmlFor="explorer-type-select" className="sr-only">
            Data type
          </label>
          <select
            id="explorer-type-select"
            value={selectedType ?? ""}
            onChange={(e) => setSelectedType(e.target.value || null)}
            className={selectClasses}
            aria-label={`Data type filter, currently ${selectedLabel}`}
          >
            <option value="">All Types</option>
            {typeEntries.map(([key, config]) => (
              <option key={key} value={key}>
                {config.label}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>
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
