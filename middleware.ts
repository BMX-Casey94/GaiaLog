import { NextResponse, type NextRequest } from "next/server"

/**
 * Canonical-host enforcement.
 *
 * Production is served from more than one host (Vercel for the web UI, a VPS
 * for the worker and overlay stack). Nothing in the repo previously forced
 * traffic onto a single hostname, so both could serve byte-identical HTML
 * declaring the same canonical. A canonical tag is a hint; a redirect is not.
 *
 * Deliberately narrow:
 *  - Only GET and HEAD are redirected. A 308 on a POST would make clients
 *    re-send the body to a new origin, so mutating requests are left alone.
 *  - Vercel preview and deployment hostnames are exempt, because they are
 *    meant to be reachable on their own origins.
 *  - `localhost` and private ranges are exempt so local development is
 *    unaffected.
 *  - `/_next/`, `/api/`, and the WhatsOnChain decoder paths are skipped: static
 *    assets and API calls should not pay a redirect, and the decoder is framed
 *    by WhatsOnChain on whatever host the plugin is registered against.
 */

const CANONICAL_HOST = "gaialog.world"
const CANONICAL_ORIGIN = `https://${CANONICAL_HOST}`

/** Paths that must never be redirected. */
const SKIP_PREFIXES = ["/_next/", "/api/", "/data-decode", "/llms-txt"]

function isExemptHost(hostname: string): boolean {
  // Local development.
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true
  // Bare IPs (private ranges, containers) are never public canonical hosts.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
  // Vercel preview and deployment URLs.
  if (hostname.endsWith(".vercel.app")) return true
  return false
}

export function middleware(request: NextRequest) {
  const hostHeader = request.headers.get("host")
  if (!hostHeader) return NextResponse.next()

  // Strip any port before comparing.
  const hostname = hostHeader.split(":")[0].toLowerCase()

  if (hostname === CANONICAL_HOST) return NextResponse.next()
  if (isExemptHost(hostname)) return NextResponse.next()

  const method = request.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") return NextResponse.next()

  const { pathname } = request.nextUrl
  if (SKIP_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return NextResponse.next()
  }

  const url = request.nextUrl.clone()
  url.protocol = "https"
  url.host = CANONICAL_HOST
  // Clear any inherited port so a reverse proxy on a non-standard port cannot
  // produce a canonical URL like `https://gaialog.world:8080/`.
  url.port = ""

  // 308 preserves the method and signals a permanent move to crawlers.
  return NextResponse.redirect(url, 308)
}

export const config = {
  // Run on everything except static asset requests and the favicon, which do
  // not benefit from a redirect and would add latency to every page load.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
