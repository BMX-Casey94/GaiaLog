"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { motion } from "framer-motion"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

interface NavItem {
  name: string
  url: string
  icon: LucideIcon
}

interface NavBarProps {
  items: NavItem[]
  className?: string
}

export function NavBar({ items, className }: NavBarProps) {
  const pathname = usePathname()
  const router = useRouter()

  const sectionIdToName = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of items) {
      const idx = item.url.indexOf("#")
      if (idx >= 0) {
        const id = item.url.slice(idx + 1)
        if (id) map.set(id, item.name)
      }
    }
    return map
  }, [items])

  const [activeTab, setActiveTab] = useState(() => {
    // Prefer route-derived state for non-home pages.
    if (pathname?.startsWith("/explorer")) return "Data Explorer"
    if (pathname !== "/") return items[0]?.name ?? "Home"

    if (typeof window !== "undefined") {
      const id = window.location.hash?.replace(/^#/, "")
      if (id && sectionIdToName.has(id)) return sectionIdToName.get(id) as string
    }
    return items[0]?.name ?? "Home"
  })

  const observerRef = useRef<IntersectionObserver | null>(null)
  const rafRef = useRef<number | null>(null)
  const suppressScrollSpyUntilRef = useRef<number>(0)

  useEffect(() => {
    // Keep active state in sync with route changes.
    if (!pathname) return
    if (pathname.startsWith("/explorer")) {
      setActiveTab("Data Explorer")
      return
    }
    if (pathname !== "/") {
      setActiveTab(items[0]?.name ?? "Home")
      return
    }

    // Home page: hash can set the active tab.
    const applyHash = () => {
      const id = window.location.hash?.replace(/^#/, "")
      if (id && sectionIdToName.has(id)) {
        setActiveTab(sectionIdToName.get(id) as string)
      } else if (window.scrollY < 120) {
        setActiveTab(items[0]?.name ?? "Home")
      }
    }

    applyHash()
    window.addEventListener("hashchange", applyHash)
    return () => window.removeEventListener("hashchange", applyHash)
  }, [items, pathname, sectionIdToName])

  useEffect(() => {
    // Scroll-spy only on home page.
    if (pathname !== "/") return

    const homeName = items[0]?.name ?? "Home"
    const sectionIds = Array.from(sectionIdToName.keys())
    const sections = sectionIds
      .map((id) => document.getElementById(id))
      .filter(Boolean) as HTMLElement[]

    if (sections.length === 0) return

    const maybeSetActive = (next: string) => {
      // Avoid fighting with immediate "click -> scroll" interactions.
      if (Date.now() < suppressScrollSpyUntilRef.current) return
      setActiveTab((prev) => (prev === next ? prev : next))
    }

    const onScrollTop = () => {
      if (Date.now() < suppressScrollSpyUntilRef.current) return
      if (window.scrollY < 120) maybeSetActive(homeName)
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)

          if (visible.length > 0) {
            const id = (visible[0].target as HTMLElement).id
            const name = sectionIdToName.get(id)
            if (name) maybeSetActive(name)
          } else if (window.scrollY < 120) {
            maybeSetActive(homeName)
          }
        })
      },
      {
        // Choose the section that crosses the middle band of the viewport.
        root: null,
        rootMargin: "-40% 0px -55% 0px",
        threshold: 0,
      },
    )

    for (const el of sections) observer.observe(el)
    window.addEventListener("scroll", onScrollTop, { passive: true })
    observerRef.current = observer

    return () => {
      window.removeEventListener("scroll", onScrollTop)
      observer.disconnect()
      observerRef.current = null
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [items, pathname, sectionIdToName])

  return (
    <div className={cn("fixed bottom-0 sm:top-0 left-1/2 -translate-x-1/2 z-50 mb-6 sm:pt-6 pointer-events-none", className)}>
      <div className="flex items-center gap-2 sm:gap-3 bg-background/5 border border-border backdrop-blur-lg py-1 px-2 sm:px-1 rounded-full shadow-lg pointer-events-auto max-w-[95vw] sm:max-w-none">
        {items.map((item) => {
          const Icon = item.icon
          const isActive = activeTab === item.name
          const hashIdx = item.url.indexOf("#")
          const hash = hashIdx >= 0 ? item.url.slice(hashIdx) : null

          const lampAndLabel = (
            <>
              <span className="hidden md:inline">{item.name}</span>
              <span className="md:hidden">
                <Icon size={18} strokeWidth={2.5} />
              </span>
              {isActive && (
                <motion.div
                  layoutId="lamp"
                  className="absolute inset-0 w-full bg-primary/5 rounded-full -z-10"
                  initial={false}
                  transition={{
                    type: "spring",
                    stiffness: 300,
                    damping: 30,
                  }}
                >
                  <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-8 h-1 bg-primary rounded-t-full">
                    <div className="absolute w-12 h-6 bg-primary/20 rounded-full blur-md -top-2 -left-2" />
                    <div className="absolute w-8 h-6 bg-primary/20 rounded-full blur-md -top-1" />
                    <div className="absolute w-4 h-4 bg-primary/20 rounded-full blur-sm top-0 left-2" />
                  </div>
                </motion.div>
              )}
            </>
          )

          const linkClassName = cn(
            "relative cursor-pointer text-sm font-semibold px-4 sm:px-6 py-2 rounded-full transition-colors",
            "text-slate-300 hover:text-primary",
            isActive && "bg-muted text-primary",
          )

          // Hash links (e.g. `/#monitoring`) keep the SPA <Link> path so
          // we can intercept and smooth-scroll on the home page.
          if (hash) {
            return (
              <Link
                key={item.name}
                href={item.url}
                onClick={(e) => {
                  e.preventDefault()
                  setActiveTab(item.name)
                  suppressScrollSpyUntilRef.current = Date.now() + 900

                  if (pathname !== "/") {
                    router.push(`/${hash}`)
                    return
                  }

                  const id = hash.replace(/^#/, "")
                  const target = document.getElementById(id)
                  if (target) {
                    target.scrollIntoView({ behavior: "smooth", block: "start" })
                    history.replaceState(null, "", hash)
                  } else {
                    history.replaceState(null, "", hash)
                  }
                }}
                className={linkClassName}
              >
                {lampAndLabel}
              </Link>
            )
          }

          // Cross-route links (e.g. `/`, `/explorer`) use a plain anchor.
          // Next.js's `<Link>` SPA transition was racing with the navbar's
          // own state/framer-motion render and silently dropping the URL
          // commit (RSC fetched, page chunk loaded, URL never updated —
          // the "Data Explorer highlights but doesn't navigate" bug). A
          // native anchor lets the browser do a normal full-page load,
          // which is fine for top-level navigation and 100% reliable.
          return (
            <a
              key={item.name}
              href={item.url}
              className={linkClassName}
            >
              {lampAndLabel}
            </a>
          )
        })}
      </div>
    </div>
  )
}
