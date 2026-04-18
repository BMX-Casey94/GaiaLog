/**
 * Edge-cache headers for high-traffic public read endpoints.
 *
 * The home-page widgets refresh on roughly a 15-30 s rhythm but are hit by
 * every visitor on every page load.  Allowing the Vercel edge to cache for
 * 15 s with a 60 s stale-while-revalidate window typically absorbs ~95% of
 * repeat traffic before it ever reaches Postgres, while keeping perceived
 * latency well under one refresh cycle.
 *
 * The headers must NOT be applied to authenticated, mutating, or
 * per-visitor endpoints.
 */

import type { NextResponse } from 'next/server'

export interface PublicCacheOptions {
  /** Edge cache freshness in seconds. Defaults to 15. */
  sMaxAgeSeconds?: number
  /** How long the edge may serve a stale response while revalidating. Defaults to 60. */
  staleWhileRevalidateSeconds?: number
}

export function applyPublicReadCacheHeaders(
  response: NextResponse,
  opts: PublicCacheOptions = {},
): NextResponse {
  const sMaxAge = Math.max(1, Math.floor(opts.sMaxAgeSeconds ?? 15))
  const swr = Math.max(0, Math.floor(opts.staleWhileRevalidateSeconds ?? 60))

  response.headers.set(
    'Cache-Control',
    `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`,
  )
  response.headers.set('Vary', 'Accept-Encoding')
  response.headers.set('CDN-Cache-Control', `public, s-maxage=${sMaxAge}`)
  return response
}
