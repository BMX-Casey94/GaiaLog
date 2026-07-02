"use client"

import { Button } from "@/components/ui/button"
import { ChevronLeft, ChevronRight } from "lucide-react"

interface PaginationControlsProps {
  page: number
  totalPages: number
  hasMore: boolean
  loading: boolean
  onPageChange: (page: number) => void
}

export function PaginationControls({ page, totalPages, hasMore, loading, onPageChange }: PaginationControlsProps) {
  if (totalPages <= 1) return null

  return (
    <div className="flex justify-center items-center gap-4">
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1 || loading}
        className="border-slate-600/50 text-slate-300 hover:bg-slate-800 bg-transparent"
      >
        <ChevronLeft className="h-4 w-4 mr-1" />
        Previous
      </Button>

      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-slate-500">Page</span>
        <span className="text-white font-semibold">{page}</span>
        <span className="text-slate-500">of</span>
        <span className="text-white font-semibold">{totalPages}</span>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(page + 1)}
        disabled={!hasMore || loading}
        className="border-slate-600/50 text-slate-300 hover:bg-slate-800 bg-transparent"
      >
        Next
        <ChevronRight className="h-4 w-4 ml-1" />
      </Button>
    </div>
  )
}
