import type { Metadata } from "next"

/**
 * Single source of truth for site-level SEO constants.
 *
 * Next.js REPLACES `openGraph` and `twitter` wholesale when a page exports them;
 * it does not deep-merge them with the root layout. A page that sets only
 * `title`/`description`/`url` therefore silently loses `og:type`, `og:locale`
 * and `og:site_name`. Every page must build its `openGraph` through
 * `buildOpenGraph` so those fields survive.
 */

export const SITE_URL = "https://gaialog.world"
export const SITE_NAME = "GaiaLog"
export const SITE_LOCALE = "en_GB"
export const SITE_DESCRIPTION =
  "Real-time environmental monitoring — air quality, water levels, seismic activity and more — with every measurement recorded immutably on the BSV blockchain."
export const SITE_LOGO = `${SITE_URL}/gaialog-logo-128.png`

/** Stable `@id` values so WebSite / Organization / Dataset cross-reference each other. */
export const ORGANIZATION_ID = `${SITE_URL}/#organization`
export const WEBSITE_ID = `${SITE_URL}/#website`

/**
 * Builds a complete Open Graph object for a page. `images` is intentionally
 * omitted: `app/opengraph-image.tsx` supplies it by file convention and Next
 * attaches it automatically.
 */
export function buildOpenGraph({
  title,
  description,
  path,
}: {
  title: string
  description: string
  path: string
}): NonNullable<Metadata["openGraph"]> {
  return {
    type: "website",
    locale: SITE_LOCALE,
    siteName: SITE_NAME,
    url: path,
    title,
    description,
  }
}

/** Builds a complete Twitter card object for a page. */
export function buildTwitter({
  title,
  description,
}: {
  title: string
  description: string
}): NonNullable<Metadata["twitter"]> {
  return {
    card: "summary_large_image",
    title,
    description,
  }
}
