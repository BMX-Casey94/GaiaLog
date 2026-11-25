/**
 * OpenSky Network OAuth2 client-credentials tokens.
 *
 * OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET are optional. When either is
 * unset, callers receive an empty header set and can use anonymous access.
 * A successful token is cached in memory and reused until 120 seconds before
 * it expires. If the token response omits expires_in, the lifetime is 25 minutes.
 * A failed refresh keeps an unexpired cached token. {} is returned when no
 * unexpired token is available. Auth failures log one warning until the next
 * successful token response.
 */

const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'

const REFRESH_SKEW_MS = 120_000
const DEFAULT_TTL_MS = 25 * 60 * 1000
const TOKEN_TIMEOUT_MS = 15_000
const MAX_TOKEN_BODY_CHARS = 65_536
const MAX_ACCESS_TOKEN_CHARS = 8_192

interface CachedToken {
  fingerprint: string
  accessToken: string
  issuedAtMs: number
  expiresAtMs: number
}

let cached: CachedToken | null = null
let inflight: { fingerprint: string; promise: Promise<CachedToken | null> } | null = null
let authFailureWarned = false
let partialCredsWarned = false

function fingerprint(clientId: string, clientSecret: string): string {
  let hash = 0x811c9dc5
  const value = `${clientId}\0${clientSecret}`
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function redact(message: string, secret: string): string {
  if (!secret || !message.includes(secret)) return message
  return message.split(secret).join('[redacted]')
}

function warnAuthFailure(message: string, secret = ''): void {
  if (authFailureWarned) return
  authFailureWarned = true
  console.warn(
    `[opensky-auth] ${redact(message, secret)}. Check OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET.`,
  )
}

function warnPartialCredentials(): void {
  if (partialCredsWarned) return
  partialCredsWarned = true
  console.warn(
    '[opensky-auth] OpenSky OAuth2 is partially configured. Set both OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET, or leave both unset for anonymous access.',
  )
}

function isUsableAccessToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ACCESS_TOKEN_CHARS
    && !/[\r\n\0]/.test(value)
}

function resolveTtlMs(expiresIn: unknown): number {
  const seconds = typeof expiresIn === 'number'
    ? expiresIn
    : typeof expiresIn === 'string' && expiresIn.trim() !== ''
      ? Number(expiresIn)
      : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TTL_MS
  return seconds * 1000
}

/** True until 120s before expiry. A lifetime shorter than the skew is kept until real expiry. */
function isFresh(entry: CachedToken, now: number): boolean {
  const refreshAt = entry.expiresAtMs - REFRESH_SKEW_MS
  if (refreshAt > entry.issuedAtMs) return now < refreshAt
  return now < entry.expiresAtMs
}

function stillValid(entry: CachedToken | null, fp: string, now: number): entry is CachedToken {
  return !!entry && entry.fingerprint === fp && now < entry.expiresAtMs
}

async function requestToken(clientId: string, clientSecret: string, fp: string): Promise<CachedToken | null> {
  const body = new URLSearchParams()
  body.set('grant_type', 'client_credentials')
  body.set('client_id', clientId)
  body.set('client_secret', clientSecret)

  try {
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    })

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_TOKEN_BODY_CHARS) {
      if (response.body) {
        try {
          await response.body.cancel()
        } catch {
          // The oversized body is discarded either way.
        }
      }
      warnAuthFailure('OpenSky token response was too large', clientSecret)
      return null
    }

    const text = await response.text()
    if (!response.ok || text.length > MAX_TOKEN_BODY_CHARS) {
      warnAuthFailure(
        !response.ok
          ? `OpenSky token request failed (HTTP ${response.status})`
          : 'OpenSky token response was too large',
        clientSecret,
      )
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      warnAuthFailure('OpenSky token response was not JSON', clientSecret)
      return null
    }

    if (!parsed || typeof parsed !== 'object') {
      warnAuthFailure('OpenSky token response was empty', clientSecret)
      return null
    }

    const record = parsed as { access_token?: unknown; expires_in?: unknown }
    if (!isUsableAccessToken(record.access_token)) {
      warnAuthFailure('OpenSky token response did not include an access_token', clientSecret)
      return null
    }

    const issuedAtMs = Date.now()
    const entry: CachedToken = {
      fingerprint: fp,
      accessToken: record.access_token,
      issuedAtMs,
      expiresAtMs: issuedAtMs + resolveTtlMs(record.expires_in),
    }
    cached = entry
    authFailureWarned = false
    return entry
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnAuthFailure(`OpenSky token request failed (${message})`, clientSecret)
    return null
  }
}

async function loadToken(clientId: string, clientSecret: string): Promise<CachedToken | null> {
  const fp = fingerprint(clientId, clientSecret)
  const now = Date.now()
  if (cached && cached.fingerprint === fp && isFresh(cached, now)) return cached

  if (inflight?.fingerprint === fp) {
    const shared = await inflight.promise
    if (shared) return shared
    return stillValid(cached, fp, Date.now()) ? cached : null
  }

  const promise = requestToken(clientId, clientSecret, fp)
  const flight = { fingerprint: fp, promise }
  inflight = flight
  try {
    const entry = await promise
    if (entry) return entry
    return stillValid(cached, fp, Date.now()) ? cached : null
  } finally {
    if (inflight === flight) inflight = null
  }
}

export async function getOpenSkyAuthHeaders(): Promise<Record<string, string>> {
  const clientId = (process.env.OPENSKY_CLIENT_ID || '').trim()
  const clientSecret = (process.env.OPENSKY_CLIENT_SECRET || '').trim()
  if (!clientId && !clientSecret) return {}
  if (!clientId || !clientSecret) {
    warnPartialCredentials()
    return {}
  }

  try {
    const entry = await loadToken(clientId, clientSecret)
    if (!entry) return {}
    return { Authorization: `Bearer ${entry.accessToken}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnAuthFailure(`OpenSky token request failed (${message})`, clientSecret)
    return {}
  }
}
