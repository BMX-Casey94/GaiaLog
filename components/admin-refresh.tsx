"use client"

/**
 * Coordinates the dashboard-wide "Refresh" action.
 *
 * The top bar and the panels are siblings, so a button in the top bar cannot
 * reach a panel's loader directly. The provider holds a counter that panels
 * watch; bumping it re-runs every mounted panel's loader exactly once.
 *
 * Panels must treat `tick` as an external trigger and not as state they write
 * back, otherwise the refresh would loop.
 */

import { createContext, useCallback, useContext, useMemo, useState } from "react"

interface AdminRefreshValue {
  /** Increments once per refresh request. */
  tick: number
  /** Requests a refresh of every mounted panel. */
  refreshAll: () => void
}

const AdminRefreshContext = createContext<AdminRefreshValue | null>(null)

export function AdminRefreshProvider({ children }: { children: React.ReactNode }) {
  const [tick, setTick] = useState(0)
  const refreshAll = useCallback(() => setTick((value) => value + 1), [])
  const value = useMemo(() => ({ tick, refreshAll }), [tick, refreshAll])
  return <AdminRefreshContext.Provider value={value}>{children}</AdminRefreshContext.Provider>
}

/**
 * Returns the shared refresh counter.
 *
 * Falls back to a static value when a panel is rendered outside the dashboard
 * (for example in isolation during development) so it still mounts and loads.
 */
export function useAdminRefresh(): AdminRefreshValue {
  const context = useContext(AdminRefreshContext)
  return context ?? { tick: 0, refreshAll: () => {} }
}
