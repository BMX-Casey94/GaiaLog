import { NextResponse, type NextRequest } from "next/server"
import { slugToLocation } from "@/lib/location-slug"

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

/** Paths that must never be redirected. */
const SKIP_PREFIXES = ["/_next/", "/api/", "/data-decode", "/llms-txt"]

const ADMIN_COOKIE = "admin_session"

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
  const { pathname } = request.nextUrl

  // ── Malformed location slugs ────────────────────────────────────────────
  //
  // A 404 raised with `notFound()` inside the page cannot set the status:
  // `app/loading.tsx` puts a Suspense boundary above every route, so the shell
  // is flushed with 200 before the page body runs. The not-found *body* still
  // renders, and it carries `noindex`, but returning 200 for a URL that does
  // not exist is a soft 404.
  //
  // Slugs that cannot decode to any location are rejected here, before
  // rendering, so they get a real 404. This needs no database access: it is a
  // pure check on the slug's shape. A well-formed slug that simply matches no
  // location still resolves through the page (see the note in
  // `app/location/[slug]/page.tsx`).
  if (pathname.startsWith("/location/")) {
    const raw = pathname.slice("/location/".length)
    // Only a single segment is a valid location URL.
    if (raw.length > 0 && !raw.includes("/")) {
      let decoded: string
      try {
        decoded = decodeURIComponent(raw)
      } catch {
        return new NextResponse("Not found", { status: 404 })
      }
      if (slugToLocation(decoded) === null) {
        return new NextResponse("Not found", { status: 404 })
      }
    }
  }

  // ── Admin gate ──────────────────────────────────────────────────────────
  //
  // `app/admin/layout.tsx` also redirects, but because the root layout has
  // already begun streaming by the time that check runs, an unauthenticated
  // request for `/admin` returns HTTP 200 with a loader shell rather than a
  // 307. Middleware runs before rendering, so this produces a real redirect and
  // avoids serving a 200 for a page no crawler should see.
  //
  // This only checks for the presence of the session cookie. Signature and
  // expiry validation remain in `isAdminAuthenticated()` inside the layout; a
  // forged or expired cookie still gets rejected there.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (!request.cookies.has(ADMIN_COOKIE)) {
      const loginUrl = request.nextUrl.clone()
      loginUrl.pathname = "/login"
      loginUrl.search = ""
      return NextResponse.redirect(loginUrl, 307)
    }
  }

  const hostHeader = request.headers.get("host")
  if (!hostHeader) return NextResponse.next()

  // Strip any port before comparing.
  const hostname = hostHeader.split(":")[0].toLowerCase()

  if (hostname === CANONICAL_HOST) return NextResponse.next()
  if (isExemptHost(hostname)) return NextResponse.next()

  const method = request.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") return NextResponse.next()

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
