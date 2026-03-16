import { fetchJsonWithRetry, type FetchOptions } from './provider-fetch'

type OwmKeyState = {
  disabledUntil: number
  cooldownUntil: number
}

const OWM_KEY_DISABLE_MS = Math.max(5 * 60 * 1000, Number(process.env.OWM_KEY_DISABLE_MS || 6 * 60 * 60 * 1000))
const OWM_KEY_COOLDOWN_MS = Math.max(60 * 1000, Number(process.env.OWM_KEY_COOLDOWN_MS || 60 * 60 * 1000))

let roundRobinCursor = 0
const keyStateByValue = new Map<string, OwmKeyState>()

function getKeyState(key: string): OwmKeyState {
  let state = keyStateByValue.get(key)
  if (!state) {
    state = { disabledUntil: 0, cooldownUntil: 0 }
    keyStateByValue.set(key, state)
  }
  return state
}

export function getOwmApiKeys(): string[] {
  const raw = [
    process.env.OWM_API_KEY,
    process.env.OWM_API_KEY_2,
    process.env.OWM_API_KEY_3,
    ...(process.env.OWM_API_KEYS || '').split(/[,\s;]+/g),
  ]

  const deduped: string[] = []
  for (const candidate of raw) {
    const key = String(candidate || '').trim()
    if (!key || deduped.includes(key)) continue
    deduped.push(key)
  }
  return deduped
}

export function hasOwmApiKeys(): boolean {
  return getOwmApiKeys().length > 0
}

function prioritiseKeys(keys: string[]): string[] {
  if (keys.length <= 1) return keys
  const now = Date.now()
  const available = keys.filter((key) => {
    const state = getKeyState(key)
    return state.disabledUntil <= now && state.cooldownUntil <= now
  })
  const constrained = keys.filter((key) => !available.includes(key))
  const ordered = available.length > 0 ? available : keys
  const start = roundRobinCursor % ordered.length
  roundRobinCursor = (roundRobinCursor + 1) % ordered.length
  const rotated = ordered.slice(start).concat(ordered.slice(0, start))
  return available.length > 0 ? rotated.concat(constrained) : rotated
}

function noteOwmKeyFailure(key: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const state = getKeyState(key)
  if (/HTTP 401/i.test(message)) {
    state.disabledUntil = Date.now() + OWM_KEY_DISABLE_MS
    return
  }
  if (/HTTP 429/i.test(message)) {
    state.cooldownUntil = Date.now() + OWM_KEY_COOLDOWN_MS
  }
}

function shortenKey(key: string): string {
  if (key.length <= 8) return key
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

export async function fetchOwmJsonWithRotation<T = any>(
  buildUrl: (apiKey: string) => string,
  opts: FetchOptions = {},
): Promise<T> {
  const keys = getOwmApiKeys()
  if (keys.length === 0) {
    throw new Error('Missing OWM_API_KEY / OWM_API_KEYS')
  }

  const errors: string[] = []
  for (const key of prioritiseKeys(keys)) {
    try {
      return await fetchJsonWithRetry<T>(buildUrl(key), {
        ...opts,
        providerId: opts.providerId || 'owm',
      })
    } catch (error) {
      noteOwmKeyFailure(key, error)
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`${shortenKey(key)}=${message}`)
    }
  }

  throw new Error(`OWM all keys failed: ${errors.join(' | ')}`)
}
