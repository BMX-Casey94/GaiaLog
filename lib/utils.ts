import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Best‑effort ASCII transliteration for display on explorers that mis-handle UTF-8.
// Keeps letters/digits/punctuation; replaces others with closest ASCII or '?' fallback.
export function toAsciiSafe(input: string | null | undefined): string | undefined {
  if (!input) return undefined
  try {
    // Normalise, then strip diacritics
    const norm = input.normalize('NFKD')
    const stripped = norm.replace(/[\u0300-\u036f]/g, '')
    // Replace common Cyrillic and a few symbols to approximate ASCII
    const map: Record<string, string> = {
      'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'E','Ж':'Zh','З':'Z','И':'I','Й':'Y','К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F','Х':'Kh','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya',
      'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'
    }
    let out = ''
    for (const ch of stripped) out += (map[ch] ?? ch)
    // Replace remaining non-ASCII with '?'
    return out.replace(/[^\x20-\x7E]/g, '?')
  } catch {
    return input
  }
}

// Canonical JSON stringifier: stable key order, no whitespace
export function stringifyCanonical(value: any): string {
  const seen = new WeakSet()
  const replacer = (_key: string, val: any) => {
    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
      if (Array.isArray(val)) return val
      // Sort object keys
      const out: Record<string, any> = {}
      for (const k of Object.keys(val).sort()) out[k] = val[k]
      return out
    }
    return val
  }
  return JSON.stringify(value, replacer)
}

// SHA-256 hex of canonical JSON
export async function sha256CanonicalHex(value: any): Promise<string> {
  const text = stringifyCanonical(value)
  const enc = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', enc)
  const bytes = Array.from(new Uint8Array(buf))
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
}

// Convert potentially string numeric (e.g. '-', '12', 12) to number or null
export function toNumberOrNull(value: any): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === '-' || trimmed.toLowerCase() === 'na') return null
  }
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Blockchain utility functions
export function getBSVNetwork(): 'main' | 'test' {
  return process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
}

export function getBSVExplorerUrl(txid: string, network?: 'main' | 'test'): string {
  const net = network || getBSVNetwork()
  const baseUrl = net === 'main' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com'
  return `${baseUrl}/tx/${txid}`
}

export function getBSVAddressUrl(address: string, network?: 'main' | 'test'): string {
  const net = network || getBSVNetwork()
  const baseUrl = net === 'main' ? 'https://whatsonchain.com' : 'https://test.whatsonchain.com'
  return `${baseUrl}/address/${address}`
}

export function isValidTxId(txid: string): boolean {
  if (!txid || typeof txid !== 'string') return false
  // Check for valid hex string of 64 characters
  return /^[0-9a-fA-F]{64}$/.test(txid)
}