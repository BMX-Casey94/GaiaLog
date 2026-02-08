import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'
const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
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
    config.resolve.alias = config.resolve.alias || {}
    config.resolve.alias['bsv'] = require.resolve('bsv', { paths: [__dirname] })
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
