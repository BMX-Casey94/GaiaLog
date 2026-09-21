import { createRequire } from 'module'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// PM2 may inject old env; `.env` on disk is source of truth for Next server/build.
dotenv.config({ path: path.join(__dirname, '.env'), override: true })

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  images: {
    unoptimized: true,
  },
  async headers() {
    // WhatsOnChain renders decoder webhooks inside an iframe on its transaction
    // pages. Sending `X-Frame-Options: SAMEORIGIN` on those paths makes the
    // browser refuse to display them (ERR_BLOCKED_BY_RESPONSE — "refused to
    // connect"), so the framing policy is expressed with CSP instead.
    const baseSecurityHeaders = [
      {
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=()',
      },
    ]

    // Mainnet, testnet and STN all sit under the whatsonchain.com domain, so the
    // wildcard covers every network without allowing third-party framing.
    const wocFrameAncestors =
      "frame-ancestors 'self' https://whatsonchain.com https://*.whatsonchain.com"

    return [
      // The published WoC entry advertises the site root as the plugin's
      // `website`, and WoC's plugin preview frames that root. Keep the decoder
      // endpoints and the root frameable by WhatsOnChain only.
      {
        source: '/',
        headers: [
          ...baseSecurityHeaders,
          { key: 'Content-Security-Policy', value: wocFrameAncestors },
        ],
      },
      // WoC plugin decoder endpoints — frameable by WhatsOnChain only.
      {
        source: '/data-decode/:path*',
        headers: [
          ...baseSecurityHeaders,
          { key: 'Content-Security-Policy', value: wocFrameAncestors },
        ],
      },
      {
        source: '/api/woc/plugins/:path*',
        headers: [
          ...baseSecurityHeaders,
          { key: 'Content-Security-Policy', value: wocFrameAncestors },
        ],
      },
      // Everything else — same-origin framing only. X-Frame-Options cannot
      // express a per-path exemption, so the policy lives in CSP.
      {
        source: '/:path((?!$)(?!data-decode/|api/woc/plugins/).*)',
        headers: [
          ...baseSecurityHeaders,
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ]
  },
  async rewrites() {
    return [
      // WOC Data Plugin style endpoints -> Next.js API route
      {
        source: '/data-decode/:network/gaialog/:txid/:vout',
        destination: '/api/woc/plugins/gaialog-data/:network/:txid/:vout',
      },
      {
        source: '/data-decode/gaialog',
        destination: '/api/woc/plugins/gaialog-data',
      },
    ]
  },
  webpack: (config, { isServer }) => {
    // Force single instance of 'bsv' to avoid duplicate-module warnings
    config.resolve = config.resolve || {}
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      // Explicit repo-root alias — some VPS builds failed to resolve `@/components/...`
      // when tsconfig paths lacked baseUrl / Next did not inject the mapping.
      '@': path.join(__dirname),
      bsv: require.resolve('bsv', { paths: [__dirname] }),
    }
    // Ensure server bundles use the single Node runtime copy of bsv
    if (isServer) {
      config.externals = config.externals || []
      if (Array.isArray(config.externals)) {
        config.externals.push('bsv')
      }
    }
    return config
  },
}

export default nextConfig
