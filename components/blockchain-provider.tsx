"use client"

/**
 * Single source of blockchain state for the admin dashboard.
 *
 * One poller serves the connection badge in the top bar, the summary card in the
 * overview, and the BSV panel. Two independent pollers would double the request
 * rate and could show contradictory values in different parts of the same
 * screen, which is worse than no indicator at all.
 *
 * The provider sits inside the dashboard shell, so it unmounts with the
 * dashboard and its interval is always cleared.
 */

import { createContext, useContext } from "react"
import { useBlockchainFeed, type BlockchainFeed } from "@/hooks/use-blockchain"

const BlockchainContext = createContext<BlockchainFeed | null>(null)

export function BlockchainProvider({ children }: { children: React.ReactNode }) {
  const feed = useBlockchainFeed()
  return <BlockchainContext.Provider value={feed}>{children}</BlockchainContext.Provider>
}

/**
 * Reads the shared blockchain feed.
 *
 * Throws when used outside the provider: a silent fallback would mount a second
 * poller, which is the problem this context exists to prevent.
 */
export function useBlockchain(): BlockchainFeed {
  const context = useContext(BlockchainContext)
  if (!context) {
    throw new Error("useBlockchain must be used inside a BlockchainProvider")
  }
  return context
}
