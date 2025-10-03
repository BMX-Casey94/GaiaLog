"use client"

import { useEffect, useMemo, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"

type Entry = Record<string, any>

export function DataEntriesPanel() {
  const [stream, setStream] = useState<string>("advanced")
  const [query, setQuery] = useState<string>("")
  const [items, setItems] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState<number>(1)
  const [total, setTotal] = useState<number>(0)
  const [limit, setLimit] = useState<number>(100)
  const [sort, setSort] = useState<string>("collected_at_desc")
  const [showAllCols, setShowAllCols] = useState<boolean>(false)

  const endpoint = useMemo(() => {
    switch (stream) {
      case "air":
        return "/api/db/air-quality"
      case "water":
        return "/api/db/water-levels"
      case "seismic":
        return "/api/db/seismic"
      default:
        return "/api/db/advanced"
    }
  }, [stream])

  const fetchData = async () => {
    setLoading(true)
    try {
      const url = new URL(endpoint, window.location.origin)
      if (query.trim()) url.searchParams.set("q", query.trim())
      url.searchParams.set("sort", sort)
      url.searchParams.set("page", String(page))
      url.searchParams.set("limit", String(limit))
      const res = await fetch(url.toString())
      const json = await res.json()
      if (json?.items) {
        setItems(json.items)
        setTotal(Number(json.total || 0))
        setLimit(Number(json.limit || limit))
      } else if (Array.isArray(json)) {
        setItems(json)
        setTotal(0)
      } else {
        setItems([])
        setTotal(0)
      }
    } catch {
      setItems([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, page, sort])

  return (
    <div className="p-6 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Data Entries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2 flex-wrap items-center">
            <Select value={stream} onValueChange={setStream}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="advanced">Advanced Metrics</SelectItem>
                <SelectItem value="air">Air Quality</SelectItem>
                <SelectItem value="water">Water Levels</SelectItem>
                <SelectItem value="seismic">Seismic</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder="Search (city/station/provider/txid)" value={query} onChange={(e) => setQuery(e.target.value)} className="w-80" />
            <Button onClick={fetchData} disabled={loading}>{loading ? "Loading..." : "Search"}</Button>
            <Button variant="outline" onClick={() => setShowAllCols((v) => !v)}>
              {showAllCols ? 'Show 10 cols' : 'Show all cols'}
            </Button>
          </div>

          <div className="overflow-auto border rounded-md">
            <table className="min-w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  {/* Prioritise key columns if present */}
                  {(() => {
                    const cols = Object.keys(items[0] || {})
                    const preferred = ["id","provider","city","station_code","location","lat","lon","collected_at","txid","source_hash"]
                    const ordered = preferred.filter(c => cols.includes(c)).concat(cols.filter(c => !preferred.includes(c)))
                    const base = ordered.length ? ordered : Object.keys(items[0] || { id: 1, provider: 1, collected_at: 1 })
                    const toShow = showAllCols ? base : base.slice(0, 10)
                    return toShow.map((k) => {
                      if (k === 'id') {
                        const isAsc = sort === 'id_asc'
                        const isDesc = sort === 'id_desc'
                        const arrow = isAsc ? '▲' : isDesc ? '▼' : ''
                        const next = isDesc ? 'id_asc' : 'id_desc'
                        return (
                          <th key={k} className="text-left px-3 py-2 whitespace-nowrap">
                            <button className="underline-offset-2 hover:underline" onClick={() => { setSort(next); setPage(1) }} title="Toggle ID sort">
                              {k} {arrow}
                            </button>
                          </th>
                        )
                      }
                      return <th key={k} className="text-left px-3 py-2 whitespace-nowrap">{k}</th>
                    })
                  })()}
                </tr>
              </thead>
              <tbody>
                {items.slice(0, 100).map((row, i) => {
                  const cols = Object.keys(items[0] || row)
                  const preferred = ["id","provider","city","station_code","location","lat","lon","collected_at","txid","source_hash"]
                  const ordered = preferred.filter(c => cols.includes(c)).concat(cols.filter(c => !preferred.includes(c)))
                  const toShow = showAllCols ? ordered : ordered.slice(0, 10)
                  return (
                    <tr key={i} className={i % 2 ? "bg-muted/20" : ""}>
                      {toShow.map((k) => (
                        <td key={k} className="px-3 py-2 whitespace-nowrap">{String(row[k])}</td>
                      ))}
                    </tr>
                  )
                })}
                {items.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-muted-foreground">No results</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between mt-3">
            <div className="text-sm text-muted-foreground">
              Page {page} • {items.length} items • Total {total}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" disabled={loading || page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
              <Button variant="outline" disabled={loading || (page * limit) >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}


