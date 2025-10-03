"use client"

import { useEffect, useState } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

type Message = {
  id: number
  name: string
  email: string
  message: string
  created_at: string
  read_at: string | null
  archived: boolean
}

export function MessagesPanel() {
  const [items, setItems] = useState<Message[]>([])
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState<Message | null>(null)

  async function load() {
    setLoading(true)
    try {
      const res = await fetch(`/api/messages?page=${page}&limit=20`)
      const data = await res.json()
      setItems(data.items || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  async function markRead(id: number) {
    try {
      const res = await fetch('/api/messages', { 
        method: 'PATCH', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify({ id: Number(id), read: true }) 
      })
      if (!res.ok) {
        console.error('Failed to mark as read:', await res.text())
        return
      }
      // Update local state immediately for better UX
      setItems((prev) => prev.map((m) => (m.id === id ? { ...m, read_at: new Date().toISOString() } : m)))
      // Also update active if it's the current message
      if (active?.id === id) {
        setActive({ ...active, read_at: new Date().toISOString() })
      }
    } catch (e) {
      console.error('Error marking as read:', e)
    }
  }


  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>Messages</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((m) => (
                  <TableRow key={m.id} className={cn(!m.read_at && "bg-muted/30")}>
                    <TableCell>{new Date(m.created_at).toLocaleString()}</TableCell>
                    <TableCell>{m.name}</TableCell>
                    <TableCell>{m.email}</TableCell>
                    <TableCell className="max-w-[420px] whitespace-pre-wrap">
                      <Dialog onOpenChange={(v) => !v && setActive(null)}>
                        <DialogTrigger asChild>
                          <button className="text-left line-clamp-2 hover:underline" onClick={() => setActive(m)}>{m.message}</button>
                        </DialogTrigger>
                        {active?.id === m.id && (
                          <DialogContent className="sm:max-w-[900px] max-h-[80vh] overflow-y-auto">
                            <DialogHeader>
                              <DialogTitle>Message from {active.name}</DialogTitle>
                            </DialogHeader>
                            <div className="space-y-2">
                              <div className="text-sm text-muted-foreground">{new Date(active.created_at).toLocaleString()} • {active.email}</div>
                              <div className="whitespace-pre-wrap">{active.message}</div>
                            </div>
                          </DialogContent>
                        )}
                      </Dialog>
                    </TableCell>
                    <TableCell>
                      {!m.read_at ? <Badge variant="secondary">New</Badge> : <Badge variant="outline">Read</Badge>}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {!m.read_at && (
                        <Button size="sm" variant="secondary" onClick={() => markRead(m.id)}>Mark as Read</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">No messages</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex justify-between items-center mt-4">
            <Button variant="ghost" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>Previous</Button>
            <span className="text-sm text-muted-foreground">Page {page}</span>
            <Button variant="ghost" disabled={loading || items.length < 20} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}


