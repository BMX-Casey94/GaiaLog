"use client"

import { useState, useEffect, useCallback, useRef, useLayoutEffect } from "react"
import { createPortal } from "react-dom"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Search, MapPin, X } from "lucide-react"
import { DATA_TYPE_CONFIG, type LocationSuggestion } from "./explorer-types"

interface SearchBarProps {
  searchQuery: string
  setSearchQuery: (q: string) => void
  selectedType: string | null
  onSubmit: (query: string) => void
  onSuggestionsOpenChange?: (open: boolean) => void
}

export function SearchBar({
  searchQuery,
  setSearchQuery,
  selectedType,
  onSubmit,
  onSuggestionsOpenChange,
}: SearchBarProps) {
  const [suggestions, setSuggestions] = useState<LocationSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const inputWrapperRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const suggestionCacheRef = useRef<Map<string, LocationSuggestion[]>>(new Map())
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties | null>(null)
  const repositionRafRef = useRef<number | null>(null)

  const dropdownOpen = showSuggestions && suggestions.length > 0
  useEffect(() => {
    onSuggestionsOpenChange?.(dropdownOpen)
  }, [dropdownOpen, onSuggestionsOpenChange])

  const fetchSuggestions = useCallback(async (query: string) => {
    const trimmedQuery = query.trim()
    if (trimmedQuery.length < 2) {
      setSuggestions([])
      return
    }

    const cacheKey = `${selectedType || 'all'}:${trimmedQuery.toLowerCase()}`
    const cached = suggestionCacheRef.current.get(cacheKey)
    if (cached) {
      setSuggestions(cached)
      return
    }

    try {
      const params = new URLSearchParams({
        q: trimmedQuery,
        limit: '10',
      })
      if (selectedType) params.set('type', selectedType)

      const res = await fetch(`/api/explorer/locations?${params.toString()}`)
      const data = await res.json()
      if (data.success) {
        const nextSuggestions = data.data.suggestions
        suggestionCacheRef.current.set(cacheKey, nextSuggestions)
        setSuggestions(nextSuggestions)
      }
    } catch (e) {
      console.error('Failed to fetch suggestions:', e)
    }
  }, [selectedType])

  // Debounce suggestions
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSuggestions(searchQuery)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, fetchSuggestions])

  // Click outside to close suggestions
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      const inSearch = !!searchRef.current && searchRef.current.contains(target)
      const inDropdown = !!dropdownRef.current && dropdownRef.current.contains(target)
      if (!inSearch && !inDropdown) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Position suggestions dropdown above other sections (avoid overflow clipping)
  const repositionDropdown = useCallback(() => {
    if (!inputWrapperRef.current) return
    const rect = inputWrapperRef.current.getBoundingClientRect()
    const gap = 8
    const viewportH = window.innerHeight
    const spaceBelow = viewportH - rect.bottom - gap
    const spaceAbove = rect.top - gap

    // Prefer opening below; flip above when there's clearly more space up top.
    const openUp = spaceBelow < 220 && spaceAbove > spaceBelow
    const maxHeight = Math.max(160, Math.min(360, (openUp ? spaceAbove : spaceBelow) - 16))

    const style: React.CSSProperties = {
      left: Math.max(8, rect.left),
      width: rect.width,
      maxHeight,
    }

    if (openUp) {
      style.bottom = Math.max(8, viewportH - rect.top + gap)
      style.top = 'auto'
    } else {
      style.top = Math.max(8, rect.bottom + gap)
      style.bottom = 'auto'
    }

    setDropdownStyle(prev => {
      // Avoid forcing re-renders on every scroll tick unless something changed
      const same =
        prev &&
        prev.left === style.left &&
        prev.top === style.top &&
        prev.bottom === style.bottom &&
        prev.width === style.width &&
        prev.maxHeight === style.maxHeight
      return same ? prev : style
    })
  }, [])

  const scheduleReposition = useCallback(() => {
    if (repositionRafRef.current !== null) return
    repositionRafRef.current = window.requestAnimationFrame(() => {
      repositionRafRef.current = null
      repositionDropdown()
    })
  }, [repositionDropdown])

  useLayoutEffect(() => {
    if (!dropdownOpen) {
      setDropdownStyle(null)
      return
    }

    scheduleReposition()

    const onScroll = () => scheduleReposition()
    const onResize = () => scheduleReposition()
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      if (repositionRafRef.current !== null) {
        window.cancelAnimationFrame(repositionRafRef.current)
        repositionRafRef.current = null
      }
    }
  }, [dropdownOpen, scheduleReposition])

  return (
    <div ref={searchRef} className="relative max-w-2xl mx-auto mb-8">
      <div ref={inputWrapperRef} className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400 z-10" />
        <Input
          type="text"
          placeholder="Search by location or coordinates (e.g. London, Tokyo, 47.14, 24.48...)"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value)
            setShowSuggestions(true)
          }}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setShowSuggestions(false)
              onSubmit(searchQuery)
            }
          }}
          className="w-full h-14 pl-12 pr-12 text-lg bg-black/40 backdrop-blur-sm border-slate-600/40 text-white placeholder:text-slate-500 focus:border-purple-500 rounded-xl"
        />
        {searchQuery && (
          <button
            onClick={() => {
              setSearchQuery('')
              onSubmit('')
            }}
            aria-label="Clear search"
            className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white z-10"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      {dropdownOpen && dropdownStyle && typeof document !== 'undefined' && createPortal(
        <div
          ref={dropdownRef}
          style={dropdownStyle}
          className="fixed z-[10000] bg-slate-900/95 backdrop-blur-md border border-slate-700/60 rounded-xl shadow-2xl overflow-y-auto overscroll-contain"
        >
          {suggestions.map((s, i) => (
            <button
              key={`${s.location}-${s.dataType}-${i}`}
              onClick={() => {
                setSearchQuery(s.location)
                setShowSuggestions(false)
                onSubmit(s.location)
              }}
              className="w-full px-4 py-3 flex items-center gap-4 hover:bg-slate-800/60 text-left transition-colors"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <MapPin className="h-4 w-4 text-purple-400 flex-shrink-0" />
                <span className="text-white truncate">{s.location}</span>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <Badge variant="secondary" className="bg-slate-800/80 text-slate-300 text-xs">
                  {DATA_TYPE_CONFIG[s.dataType]?.label || s.dataType}
                </Badge>
                <span className="text-xs text-slate-500 whitespace-nowrap">{s.readingCount} readings</span>
              </div>
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}
