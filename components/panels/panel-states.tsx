"use client"

import { AlertCircle, Inbox } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { formatDateTime } from "@/lib/admin-format"
import { cn } from "@/lib/utils"

/** Message shown when a panel's request fails. */
export function PanelError({
  title = "Could not load this data",
  message,
  onRetry,
  retrying = false,
  className,
}: {
  title?: string
  message: string
  onRetry?: () => void
  retrying?: boolean
  className?: string
}) {
  return (
    <Card className={cn("border-destructive/40", className)}>
      <CardContent className="flex items-start gap-3 pt-6">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
        <div className="space-y-2">
          <p className="font-medium text-destructive">{title}</p>
          <p className="text-sm text-muted-foreground">{message}</p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
              {retrying ? "Retrying…" : "Try again"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** Message shown when the request succeeded but the table has no rows. */
export function PanelEmpty({
  title = "No readings yet",
  message,
  className,
}: {
  title?: string
  message: string
  className?: string
}) {
  return (
    <Card className={className}>
      <CardContent className="flex items-start gap-3 pt-6">
        <Inbox className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="space-y-2">
          <p className="font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * Warns when the newest stored reading is older than the expected collection
 * cadence.
 *
 * Without this, a reading from months ago renders as a bare time of day and
 * reads as current data. That is the most damaging kind of dashboard bug: the
 * numbers look plausible and the operator has no reason to doubt them.
 */
export function StaleReadingNotice({
  collectedAt,
  ageMs,
  staleAfterMs = 60 * 60 * 1000,
  className,
}: {
  collectedAt: string | null | undefined
  ageMs: number | null
  staleAfterMs?: number
  className?: string
}) {
  if (ageMs == null || ageMs <= staleAfterMs) return null
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-900 dark:text-yellow-200",
        className,
      )}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <p className="font-medium">This reading is out of date</p>
        <p>
          The newest stored reading is from {formatDateTime(collectedAt)}. The collectors may have
          stopped, so treat these figures as historical rather than live.
        </p>
      </div>
    </div>
  )
}
