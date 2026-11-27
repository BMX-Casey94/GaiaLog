"use client"

import { useCallback, useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { PanelError } from "@/components/panels/panel-states"
import { MISSING, formatDateTime } from "@/lib/admin-format"
import { cn } from "@/lib/utils"

interface ContactMessage {
  id: number
  name: string
  email: string
  message: string
  created_at: string
  read_at: string | null
  archived: boolean
}

const PAGE_SIZE = 20

export function MessagesPanel() {
  const [items, setItems] = useState<ContactMessage[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [openMessage, setOpenMessage] = useState<ContactMessage | null>(null)
  const [markingId, setMarkingId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/messages?page=${page}&limit=${PAGE_SIZE}`, { cache: "no-store" })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : `Request failed (${res.status})`)
      }
      const rows: ContactMessage[] = Array.isArray(body?.items) ? body.items : []
      setItems(rows)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load messages")
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => {
    void load()
  }, [load])

  async function markRead(id: number) {
    setMarkingId(id)
    setActionError(null)
    try {
      const res = await fetch("/api/messages", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, read: true }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(
          typeof body?.error === "string" ? body.error : `Request failed (${res.status})`,
        )
      }
      // The PATCH route sets read_at server-side; mirror that locally so the
      // row updates without a full refetch.
      const readAt = new Date().toISOString()
      setItems((previous) => previous.map((item) => (item.id === id ? { ...item, read_at: readAt } : item)))
      setOpenMessage((previous) => (previous?.id === id ? { ...previous, read_at: readAt } : previous))
    } catch (err) {
      setActionError(
        err instanceof Error ? `Could not mark the message as read: ${err.message}` : "Could not mark the message as read",
      )
    } finally {
      setMarkingId(null)
    }
  }

  function open(message: ContactMessage) {
    setOpenMessage(message)
    // Opening a message counts as reading it.
    if (!message.read_at) void markRead(message.id)
  }

  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>Messages</CardTitle>
          <CardDescription>
            Enquiries submitted through the public contact form, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(error || actionError) && (
            <PanelError
              title={error ? "Messages could not be loaded" : "Action failed"}
              message={error ?? actionError ?? ""}
              onRetry={error ? load : undefined}
              retrying={loading}
            />
          )}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((message) => (
                  <TableRow key={message.id} className={cn(!message.read_at && "bg-muted/30")}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(message.created_at)}</TableCell>
                    <TableCell className="whitespace-nowrap">{message.name}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <a href={`mailto:${message.email}`} className="underline">
                        {message.email}
                      </a>
                    </TableCell>
                    <TableCell className="max-w-[420px]">
                      <button
                        type="button"
                        className="block max-w-full cursor-pointer truncate text-left hover:underline"
                        onClick={() => open(message)}
                        title={message.message}
                      >
                        {message.message}
                      </button>
                    </TableCell>
                    <TableCell>
                      {message.read_at ? (
                        <Badge variant="outline">Read</Badge>
                      ) : (
                        <Badge variant="secondary">New</Badge>
                      )}
                    </TableCell>
                    <TableCell className="space-x-2 whitespace-nowrap text-right">
                      <Button size="sm" variant="outline" onClick={() => open(message)}>
                        View
                      </Button>
                      {!message.read_at && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void markRead(message.id)}
                          disabled={markingId === message.id}
                        >
                          {markingId === message.id ? "Marking…" : "Mark as read"}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {items.length === 0 && !loading && !error && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No messages have been received yet.
                    </TableCell>
                  </TableRow>
                )}
                {loading && items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <Button
              variant="ghost"
              disabled={page <= 1 || loading}
              onClick={() => setPage((previous) => Math.max(1, previous - 1))}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">Page {page}</span>
            <Button
              variant="ghost"
              // The list endpoint does not return a total, so a full page is the
              // only signal that another page may exist.
              disabled={loading || items.length < PAGE_SIZE}
              onClick={() => setPage((previous) => previous + 1)}
            >
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={openMessage !== null} onOpenChange={(isOpen) => !isOpen && setOpenMessage(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[900px]">
          <DialogHeader>
            <DialogTitle>Message from {openMessage?.name ?? MISSING}</DialogTitle>
            <DialogDescription>
              {openMessage ? formatDateTime(openMessage.created_at) : MISSING}
              {openMessage ? ` · ${openMessage.email}` : ""}
            </DialogDescription>
          </DialogHeader>
          <p className="whitespace-pre-wrap text-sm">{openMessage?.message ?? ""}</p>
        </DialogContent>
      </Dialog>
    </div>
  )
}
