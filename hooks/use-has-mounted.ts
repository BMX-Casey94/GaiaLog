"use client"

import { useEffect, useState } from "react"

/**
 * False during server rendering and the first client render, true afterwards.
 *
 * Use this to gate any markup whose content depends on browser-only state
 * (stored theme, media queries, the wall clock). Returning false for the first
 * render keeps the server and client output identical, which is what React
 * requires for hydration.
 */
export function useHasMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}
