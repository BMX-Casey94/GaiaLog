"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { ExternalLink, Mail } from "lucide-react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useState } from "react"
import { toast } from "@/hooks/use-toast"
import { AttributionBar } from "@/components/attribution-bar"

export function Footer() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [message, setMessage] = useState("")
  const [open, setOpen] = useState(false)
  const [captchaQ, setCaptchaQ] = useState("")
  const [captchaToken, setCaptchaToken] = useState("")
  const [captchaAnswer, setCaptchaAnswer] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function submitMessage() {
    if (submitting) return
    setSubmitting(true)
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message, captchaToken: await buildCaptchaToken() }),
      })
      if (!res.ok) throw new Error("Request failed")
      toast({ title: "Message sent successfully", description: "Thank you!" })
      setName("")
      setEmail("")
      setMessage("")
      setCaptchaAnswer("")
      setOpen(false)
    } catch (e) {
      toast({ title: "Could not send message", description: "Please try again later." })
    } finally {
      setSubmitting(false)
    }
  }

  async function refreshCaptcha() {
    try {
      const res = await fetch('/api/captcha', { cache: 'no-store' })
      const data = await res.json()
      setCaptchaQ(data.question)
      setCaptchaToken(data.token)
      setCaptchaAnswer("")
    } catch {
      setCaptchaQ("What is 1 + 1?")
      setCaptchaToken("")
    }
  }

  async function buildCaptchaToken() {
    // the server token already contains the answer; attach user's answer for redundancy
    // Format: baseToken|userAnswer
    return `${captchaToken}|${captchaAnswer}`
  }
  return (
    <footer className="relative py-16 px-4 sm:px-6 lg:px-8">
      <div aria-hidden className="section-divider absolute top-0 left-0 right-0" />
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          <div className="col-span-1 md:col-span-2">
            <h3 className="font-display text-xl font-bold text-white mb-4">GaiaLog</h3>
            <p className="text-slate-400 mb-4 max-w-md">
              Immutable environmental monitoring through blockchain technology. Every measurement matters, every record
              counts.
            </p>
            <div className="flex space-x-4">
              <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) { refreshCaptcha() } }}>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white">
                    <Mail className="h-4 w-4 mr-2" />
                    Contact
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Contact GaiaLog</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-sm" htmlFor="contact-name">Name</label>
                      <Input id="contact-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm" htmlFor="contact-email">E-mail</label>
                      <Input id="contact-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm" htmlFor="contact-message">Message</label>
                      <Textarea id="contact-message" value={message} onChange={(e) => setMessage(e.target.value.slice(0,3000))} placeholder="How can we help?" rows={5} />
                      <p className="text-xs text-muted-foreground">{message.length}/3000</p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm" htmlFor="contact-captcha">Captcha</label>
                        <button type="button" className="text-xs underline" onClick={refreshCaptcha}>Refresh</button>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{captchaQ}</span>
                        <Input id="contact-captcha" value={captchaAnswer} onChange={(e) => setCaptchaAnswer(e.target.value)} placeholder="Answer" className="w-28" />
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={submitMessage} disabled={!name || !email || !message || !captchaAnswer || submitting}>
                      {submitting ? "Sending..." : "Send"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-white mb-4">Resources</h4>
            <ul className="space-y-2 text-sm text-slate-400">
              <li>
                <Link href="/#monitoring" className="hover:text-white transition-colors">
                  Live Alerts
                </Link>
              </li>
              <li>
                <Link href="/#blockchain" className="hover:text-white transition-colors">
                  Blockchain Explorer
                </Link>
              </li>
              <li>
                <Link href="/#data-sources" className="hover:text-white transition-colors">
                  Data Sources
                </Link>
              </li>
              <li>
                <Link href="/#how-it-works" className="hover:text-white transition-colors">
                  How It Works
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h4 className="font-semibold text-white mb-4">External Links</h4>
            <ul className="space-y-2 text-sm text-slate-400">
              <li>
                <a
                  href="https://whatsonchain.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors flex items-center"
                >
                  BSV Blockchain Explorer
                  <ExternalLink className="h-3 w-3 ml-1" />
                </a>
              </li>
              <li>
                <a href="https://bsvassociation.org" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors flex items-center">
                  BSV Association
                  <ExternalLink className="h-3 w-3 ml-1" />
                </a>
              </li>
              <li>
                <a href="https://teranode.group" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors flex items-center">
                  Teranode
                  <ExternalLink className="h-3 w-3 ml-1" />
                </a>
              </li>
              <li>
                <a href="https://gorillapool.com" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors flex items-center">
                  GorillaPool
                  <ExternalLink className="h-3 w-3 ml-1" />
                </a>
              </li>
 
            </ul>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-8 text-center space-y-3">
          <p className="text-sm text-slate-500">
            © {new Date().getFullYear()} GaiaLog. Environmental data powered by BSV blockchain technology.
          </p>
          <AttributionBar />
        </div>
      </div>
    </footer>
  )
}
