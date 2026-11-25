import type { MetadataRoute } from "next"

const SITE_URL = "https://gaialog.world"

/**
 * Search engines are kept out of `/api/` so raw JSON is not indexed alongside
 * the HTML pages.
 *
 * AI and LLM crawlers get an explicit allowance for the public read-only data
 * endpoints, because those endpoints are the only machine-usable form of the
 * dataset — the explorer itself renders results client-side. Without this,
 * `llms.txt` would advertise a data surface that robots.txt forbids.
 *
 * robots.txt is advisory only and is not an access control mechanism. The
 * endpoints listed below are intentionally public; everything with side effects
 * is protected server-side.
 */
const PUBLIC_DATA_PATHS = [
  "/api/explorer/",
  "/api/air-quality/latest",
  "/api/water-levels/latest",
  "/api/seismic/latest",
  "/api/advanced-metrics/latest",
]

/** Crawlers that feed LLM training corpora, retrieval indexes, or AI answers. */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "cohere-ai",
  "MistralAI-User",
  "DuckAssistBot",
  "meta-externalagent",
  "Amazonbot",
  "YouBot",
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/admin", "/login", "/api/"],
      },
      {
        // Longest match wins in the robots exclusion protocol, so the
        // `/api/...` allow rules below take precedence over any broader
        // disallow for these agents.
        userAgent: AI_CRAWLERS,
        allow: ["/", "/llms.txt", ...PUBLIC_DATA_PATHS],
        disallow: ["/admin", "/login"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}
