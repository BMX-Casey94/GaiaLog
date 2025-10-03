import { providerConfigs, ProviderId } from './provider-registry'
import { query } from './db'

let cachedSettings: Record<string, { allow?: string[]; deny?: string[]; quotas?: Record<string, { perDay?: number; perMinute?: number }> }> | null = null
let lastLoaded = 0
const TTL_MS = 60 * 1000

async function loadSettings(): Promise<void> {
  const now = Date.now()
  if (cachedSettings && now - lastLoaded < TTL_MS) return
  try {
    const res = await query<any>('SELECT provider, allow, deny, quotas FROM provider_country_settings')
    const map: any = {}
    for (const r of res.rows) map[r.provider] = { allow: r.allow || undefined, deny: r.deny || undefined, quotas: r.quotas || undefined }
    cachedSettings = map
    lastLoaded = now
  } catch {
    // ignore; fallback to providerConfigs
  }
}

export function isCountryAllowed(provider: ProviderId, country?: string | null): boolean {
  const cfg = providerConfigs[provider]
  if (!country || !cfg?.countries) return true
  const cc = country.toUpperCase()
  const db = (cachedSettings && cachedSettings[provider]) || null
  const deny = (db?.deny || cfg.countries.deny || [])
  if (deny.includes(cc)) return false
  const allow = db?.allow ?? cfg.countries.allow
  if (Array.isArray(allow) && allow.length > 0) return allow.includes(cc)
  return true
}

export function getCountryQuota(provider: ProviderId, country?: string | null): { perDay?: number; perMinute?: number } | undefined {
  const cfg = providerConfigs[provider]
  if (!country || !cfg?.countries?.quotas) return undefined
  const db = (cachedSettings && cachedSettings[provider]) || null
  const src = db?.quotas || cfg.countries.quotas
  return src[country.toUpperCase()]
}

export async function refreshCountrySettings(): Promise<void> {
  await loadSettings()
}


