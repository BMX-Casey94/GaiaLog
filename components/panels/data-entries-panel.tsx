"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PanelError } from "@/components/panels/panel-states"
import { MISSING, formatDateTime, formatNumber } from "@/lib/admin-format"
import { getExplorerUrl } from "@/lib/bsv-links"
import { cn } from "@/lib/utils"
import { ArrowDown, ArrowUp, Search } from "lucide-react"

type Row = Record<string, unknown>

type StreamId = "advanced" | "air" | "water" | "seismic"

type SortId = "collected_at_desc" | "collected_at_asc" | "id_desc" | "id_asc"

const STREAMS: Array<{ id: StreamId; label: string; endpoint: string }> = [
  { id: "advanced", label: "Advanced metrics", endpoint: "/api/db/advanced" },
  { id: "air", label: "Air quality", endpoint: "/api/db/air-quality" },
  { id: "water", label: "Water levels", endpoint: "/api/db/water-levels" },
  { id: "seismic", label: "Seismic", endpoint: "/api/db/seismic" },
]

const SORTS: Array<{ id: SortId; label: string }> = [
  { id: "collected_at_desc", label: "Newest first" },
  { id: "collected_at_asc", label: "Oldest first" },
  { id: "id_desc", label: "ID descending" },
  { id: "id_asc", label: "ID ascending" },
]

/** Columns worth showing first; anything else follows in the API's own order. */
const PREFERRED_COLUMNS = [
  "id",
  "provider",
  "city",
  "station_code",
  "location",
  "lat",
  "lon",
  "collected_at",
  "txid",
  "source_hash",
]

const PAGE_SIZE = 50

function cellText(value: unknown): string {
  if (value == null) return MISSING
  if (typeof value === "string") return value.length > 0 ? value : MISSING
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

/** Columns that describe a transaction should link to WhatsOnChain. */
function isTxidColumn(column: string): boolean {
  return column === "txid"
}

export function DataEntriesPanel() {
  const [stream, setStream] = useState<StreamId>("advanced")
  const [queryInput, setQueryInput] = useState("")
  const [appliedQuery, setAppliedQuery] = useState("")
  const [sort, setSort] = useState<SortId>("collected_at_desc")
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAllColumns, setShowAllColumns] = useState(false)

  const endpoint = useMemo(
    () => STREAMS.find((candidate) => candidate.id === stream)?.endpoint ?? STREAMS[0].endpoint,
    [stream],
  )

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const url = new URL(endpoint, window.location.origin)
      if (appliedQuery.length > 0) url.searchParams.set("q", appliedQuery)
      url.searchParams.set("sort", sort)
      url.searchParams.set("page", String(page))
      url.searchParams.set("limit", String(PAGE_SIZE))

      const res = await fetch(url.toString(), { cache: "no-store" })
      const body = await res.json().catch(() => null)

      if (!res.ok || body?.success === false) {
        throw new Error(
          typeof body?.error === "string" ? body.error : `Request failed (${res.status})`,
        )
      }

      const rows: Row[] = Array.isArray(body?.items) ? body.items : []
      setItems(rows)
      setTotal(typeof body?.total === "number" ? body.total : rows.length)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load entries")
      setItems([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [endpoint, appliedQuery, sort, page])

  useEffect(() => {
    void load()
  }, [load])

  const columns = useMemo(() => {
    const discovered = new Set<string>()
    for (const row of items.slice(0, PAGE_SIZE)) {
      for (const key of Object.keys(row)) discovered.add(key)
    }
    const present = Array.from(discovered)
    const ordered = PREFERRED_COLUMNS.filter((column) => discovered.has(column)).concat(
      present.filter((column) => !PREFERRED_COLUMNS.includes(column)),
    )
    return showAllColumns ? ordered : ordered.slice(0, 10)
  }, [items, showAllColumns])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  function submitSearch(event: React.FormEvent) {
    event.preventDefault()
    setPage(1)
    setAppliedQuery(queryInput.trim())
  }

  return (
    <div className="space-y-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Data entries</CardTitle>
          <CardDescription>
            Raw rows as stored, with their transaction identifiers. Search matches the city, station,
            provider or transaction id, depending on the table.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
            <Select
              value={stream}
              onValueChange={(value) => {
                setStream(value as StreamId)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-48" aria-label="Data stream">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STREAMS.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Input
              placeholder="Search by city, station, provider or transaction id"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              className="w-80"
              aria-label="Search entries"
            />

            <Select
              value={sort}
              onValueChange={(value) => {
                setSort(value as SortId)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-44" aria-label="Sort order">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button type="submit" disabled={loading}>
              <Search className="mr-2 h-4 w-4" aria-hidden />
              {loading ? "Searching…" : "Search"}
            </Button>

            {appliedQuery && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setQueryInput("")
                  setAppliedQuery("")
                  setPage(1)
                }}
              >
                Clear search
              </Button>
            )}

            <Button
              type="button"
              variant="outline"
              onClick={() => setShowAllColumns((previous) => !previous)}
              aria-pressed={showAllColumns}
            >
              {showAllColumns ? "Show fewer columns" : "Show all columns"}
            </Button>
          </form>

          {error && (
            <PanelError title="Entries could not be loaded" message={error} onRetry={load} retrying={loading} />
          )}

          <div className="overflow-auto rounded-md border">
            <table className="min-w-full text-sm">
              <thead className="bg-muted">
                <tr>
                  {columns.map((column) => {
                    const ascending = sort === `${column}_asc`
                    const descending = sort === `${column}_desc`
                    const sortable = column === "id" || column === "collected_at"
                    return (
                      <th
                        key={column}
                        scope="col"
                        className="whitespace-nowrap px-3 py-2 text-left font-medium"
                        aria-sort={
                          ascending ? "ascending" : descending ? "descending" : sortable ? "none" : undefined
                        }
                      >
                        {sortable ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 hover:underline"
                            onClick={() => {
                              const next: SortId = ascending
                                ? (`${column}_desc` as SortId)
                                : (`${column}_asc` as SortId)
                              setSort(next)
                              setPage(1)
                            }}
                          >
                            {column}
                            {ascending && <ArrowUp className="h-3 w-3" aria-hidden />}
                            {descending && <ArrowDown className="h-3 w-3" aria-hidden />}
                          </button>
                        ) : (
                          column
                        )}
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {items.map((row, index) => (
                  <tr key={String(row.id ?? index)} className={cn(index % 2 === 1 && "bg-muted/20")}>
                    {columns.map((column) => {
                      const value = row[column]
                      const text = cellText(value)
                      const linkable = isTxidColumn(column) && typeof value === "string" && /^[0-9a-f]{64}$/i.test(value)
                      return (
                        <td
                          key={column}
                          className="max-w-[24rem] truncate whitespace-nowrap px-3 py-2"
                          title={text}
                        >
                          {linkable ? (
                            <a
                              href={getExplorerUrl(String(value))}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-xs underline"
                            >
                              {String(value).slice(0, 12)}…
                            </a>
                          ) : (
                            text
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {items.length === 0 && !loading && !error && (
                  <tr>
                    <td className="px-3 py-6 text-muted-foreground" colSpan={Math.max(1, columns.length)}>
                      {appliedQuery
                        ? "No rows match this search."
                        : "This table has no rows yet. The collector workers have not written any readings."}
                    </td>
                  </tr>
                )}
                {loading && items.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-muted-foreground" colSpan={Math.max(1, columns.length)}>
                      Loading…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              Page {formatNumber(page)} of {formatNumber(totalPages)} · {formatNumber(items.length)}{" "}
              rows on this page · {formatNumber(total)} matching rows
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={loading || page <= 1}
                onClick={() => setPage((previous) => Math.max(1, previous - 1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={loading || page >= totalPages}
                onClick={() => setPage((previous) => previous + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
