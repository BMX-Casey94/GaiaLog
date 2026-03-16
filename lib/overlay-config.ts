export type OverlayAuthMode = 'none' | 'brc104'
export type QueueGateSource = 'legacy' | 'overlay'

export interface OverlayClientAuthConfig {
  mode: OverlayAuthMode
  identityWif: string | null
}

export interface OverlayServerConfig {
  bindHost: string
  port: number
  hostId: string
  jsonLimitBytes: number
  serverIdentityWif: string | null
  auditHmacSecret: string | null
  allowedIps: string[]
  allowedIdentityKeys: string[]
  rateLimitWindowMs: number
  rateLimitMax: number
}

export interface OverlayFallbackConfig {
  forcedLegacyWalletIndexes: number[]
  failureThreshold: number
  fallbackCooldownMs: number
  queueGateSource: QueueGateSource
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
}

function parsePositiveInt(value: string | undefined, fallback: number, min: number = 1): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.floor(parsed))
}

function parseWalletIndexes(value: string | undefined): number[] {
  const indexes = parseCsv(value)
    .map(entry => Number(entry))
    .filter(entry => Number.isFinite(entry) && entry >= 1)
    .map(entry => Math.floor(entry - 1))

  return Array.from(new Set(indexes)).sort((left, right) => left - right)
}

export function getOverlayClientAuthConfig(): OverlayClientAuthConfig {
  const identityWif = String(process.env.BSV_OVERLAY_CLIENT_IDENTITY_WIF || '').trim() || null
  const requestedMode = String(process.env.BSV_OVERLAY_AUTH_MODE || '').trim().toLowerCase()

  if (requestedMode === 'none') {
    return { mode: 'none', identityWif }
  }

  const lookupUrl = String(process.env.BSV_OVERLAY_LOOKUP_URL || '').trim()
  const isLocalhost = /^https?:\/\/(127\.0\.0\.1|localhost|::1)(:|\/|$)/.test(lookupUrl)
  if (isLocalhost) {
    return { mode: 'none', identityWif }
  }

  if (requestedMode === 'brc104' || identityWif) {
    return { mode: 'brc104', identityWif }
  }

  return { mode: 'none', identityWif: null }
}

export function getOverlayServerConfig(): OverlayServerConfig {
  return {
    bindHost: String(process.env.GAIALOG_OVERLAY_BIND_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: parsePositiveInt(process.env.GAIALOG_OVERLAY_PORT, 3100),
    hostId: String(process.env.GAIALOG_OVERLAY_HOST_ID || process.env.HOSTNAME || 'vps-1').trim() || 'vps-1',
    jsonLimitBytes: parsePositiveInt(process.env.GAIALOG_OVERLAY_JSON_LIMIT_BYTES, 10 * 1024 * 1024, 1024),
    serverIdentityWif: String(process.env.GAIALOG_OVERLAY_SERVER_IDENTITY_WIF || '').trim() || null,
    auditHmacSecret: String(process.env.GAIALOG_OVERLAY_AUDIT_HMAC_SECRET || '').trim() || null,
    allowedIps: parseCsv(process.env.GAIALOG_OVERLAY_ALLOWED_IPS || '127.0.0.1,::1,::ffff:127.0.0.1'),
    allowedIdentityKeys: parseCsv(process.env.GAIALOG_OVERLAY_ALLOWED_IDENTITY_KEYS),
    rateLimitWindowMs: parsePositiveInt(process.env.GAIALOG_OVERLAY_RATE_LIMIT_WINDOW_MS, 60_000, 1000),
    rateLimitMax: parsePositiveInt(process.env.GAIALOG_OVERLAY_RATE_LIMIT_MAX, 600, 1),
  }
}

export function getOverlayFallbackConfig(): OverlayFallbackConfig {
  const queueGateSource = String(process.env.GAIALOG_QUEUE_GATE_SOURCE || 'legacy').trim().toLowerCase()
  return {
    forcedLegacyWalletIndexes: parseWalletIndexes(
      process.env.BSV_OVERLAY_FORCE_LEGACY_WALLETS || process.env.BSV_OVERLAY_DISABLED_WALLETS,
    ),
    failureThreshold: parsePositiveInt(process.env.BSV_OVERLAY_WALLET_FAILURE_THRESHOLD, 3),
    fallbackCooldownMs: parsePositiveInt(process.env.BSV_OVERLAY_WALLET_FALLBACK_COOLDOWN_MS, 5 * 60 * 1000, 1000),
    queueGateSource: queueGateSource === 'overlay' ? 'overlay' : 'legacy',
  }
}
