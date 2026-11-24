/**
 * Chaintracks header client.
 *
 * Chaintracks serves raw 80-byte block headers. Two deployments are supported
 * from the same code:
 *
 *   - self-hosted at `http://127.0.0.1:3011` (or any operator URL) with a `/v2`
 *     prefix. Headers here are the operator's own copy of the chain, which is
 *     the only source this module treats as sufficiently trusted to set
 *     `spvVerified` without local linkage work.
 *   - public Arcade at `https://arcade-eu-1.bsvblockchain.tech/chaintracks`, also
 *     with a `/v2` prefix. Live paths verified:
 *       `GET /v2/header/height/{height}`  → JSON header
 *       `GET /v2/header/hash/{hash}`      → JSON header
 *       `GET /v2/headers.bin?height={h}&count={n}` → `count * 80` bytes
 *       `GET /v2/height`                  → `{height}`
 *       `GET /v2/tip`                     → JSON header
 *
 * `arcade.gorillapool.io` has no Chaintracks service, so it is never a header
 * source.
 *
 * ## What "verified" means here
 *
 * A header fetched over HTTPS is only as trustworthy as the host. What makes it
 * evidence is that it is *internally consistent* with its neighbours: the
 * header's own hash must be below its stated target (proof of work), and the
 * next header's `previousHash` must equal it. A single header whose hash is
 * below target and which links to a neighbour is expensive to fabricate; a
 * header with no linkage at all is cheap.
 *
 * Hence `verifyHeaderAgainstParent` is the gate for `spvVerified`, and
 * `isLocallyVerified` records which heights passed it.
 */

import { Hash } from '@bsv/sdk'

export interface BlockHeaderInfo {
  height: number
  hash: string
  previousHash: string
  merkleRoot: string
  version: number
  time: number
  bits: number
  nonce: number
}

export interface HeaderChainLinkageResult {
  /** True when every adjacent pair links: `child.previousHash === parent.hash`. */
  linked: boolean
  /** True when every header's hash satisfies its own `bits` target. */
  workValid: boolean
  /** Height of the first header that failed either check, when one did. */
  failedAtHeight?: number
  reason?: string
}

/** The JSON header shape Arcade returns. */
interface RawHeaderJson {
  version?: unknown
  previousHash?: unknown
  merkleRoot?: unknown
  time?: unknown
  bits?: unknown
  nonce?: unknown
  height?: unknown
  hash?: unknown
}

const DEFAULT_CHAINTRACKS_URL = 'https://arcade-eu-1.bsvblockchain.tech/chaintracks'
const HEADER_BYTES = 80
const HEADER_TIMEOUT_MS = Math.max(1_000, Number(process.env.BSV_CHAINTRACKS_TIMEOUT_MS || 8_000))
const MAX_HEADER_BATCH = Math.max(1, Number(process.env.BSV_CHAINTRACKS_MAX_BATCH || 2_000))
/** Bounded cache: a miner sweep touches a handful of heights, not the chain. */
const MAX_CACHED_HEADERS = 5_000

/**
 * Height → header, plus a set recording which heights were proven by local
 * linkage rather than only fetched. Insertion order is eviction order (Map
 * semantics), which suits a working set: the oldest lookup is the least likely
 * to be needed again.
 */
const headerCache = new Map<number, BlockHeaderInfo>()
const locallyVerifiedHeights = new Set<number>()
const inFlightHeaderRequests = new Map<number, Promise<BlockHeaderInfo | null>>()

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const normalised = raw.trim().toLowerCase()
  if (normalised === 'true' || normalised === '1') return true
  if (normalised === 'false' || normalised === '0') return false
  return fallback
}

/**
 * The configured Chaintracks base URL, normalised.
 *
 * Accepts a URL with or without the `/v2` prefix, because operators copy either
 * form out of the Chaintracks documentation, and with or without the
 * `/chaintracks` path, because the public host keeps that as a prefix while a
 * self-hosted server serves the same API at its root.
 */
export function getChaintracksBaseUrl(): string {
  const configured = String(process.env.BSV_CHAINTRACKS_URL ?? '').trim().replace(/\/+$/, '')
  const chosen = configured || DEFAULT_CHAINTRACKS_URL
  return chosen.replace(/\/v2$/i, '')
}

function v2Url(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${trimmed}/v2${suffix}`
}

/**
 * True when headers come from an operator-controlled server rather than a
 * third-party host over the public internet.
 *
 * Loopback and private-range hosts are the self-hosted case. A public HTTPS
 * host is only as trustworthy as its operator, so its headers must be proven by
 * linkage before they can support `spvVerified`.
 */
export function isSelfHostedChaintracks(): boolean {
  if (envBool('BSV_CHAINTRACKS_TRUSTED', false)) return true
  let hostname: string
  try {
    hostname = new URL(getChaintracksBaseUrl()).hostname
  } catch {
    return false
  }
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (bare === 'localhost' || bare === '127.0.0.1' || bare === '::1') return true
  // RFC1918 / link-local: a self-hosted Chaintracks on the operator's network.
  if (/^10\./.test(bare)) return true
  if (/^192\.168\./.test(bare)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true
  if (/^169\.254\./.test(bare)) return true
  return false
}

function cacheHeader(header: BlockHeaderInfo): void {
  headerCache.delete(header.height)
  headerCache.set(header.height, header)
  while (headerCache.size > MAX_CACHED_HEADERS) {
    const oldest = headerCache.keys().next()
    if (oldest.done) break
    headerCache.delete(oldest.value)
    locallyVerifiedHeights.delete(oldest.value)
  }
}

function coerceInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function coerceHashHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hex = value.trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

/** Compute a header's hash: double-SHA256 of its 80 bytes, byte-reversed. */
function hashHeaderBytes(raw: Uint8Array): string {
  const digest = Hash.hash256(Array.from(raw))
  return Buffer.from(digest as number[]).reverse().toString('hex')
}

/** Decode one 80-byte header at `offset`. Throws if the slice is short. */
function decodeRawHeader(buffer: Uint8Array, offset: number, height: number): BlockHeaderInfo {
  if (offset + HEADER_BYTES > buffer.length) {
    throw new Error(
      `headers.bin is short: needed ${offset + HEADER_BYTES} bytes, got ${buffer.length}`,
    )
  }
  const view = Buffer.from(buffer.buffer, buffer.byteOffset + offset, HEADER_BYTES)
  const version = view.readUInt32LE(0)
  const previousHash = Buffer.from(view.subarray(4, 36)).reverse().toString('hex')
  const merkleRoot = Buffer.from(view.subarray(36, 68)).reverse().toString('hex')
  const time = view.readUInt32LE(68)
  const bits = view.readUInt32LE(72)
  const nonce = view.readUInt32LE(76)
  const hash = hashHeaderBytes(view)
  return { height, hash, previousHash, merkleRoot, version, time, bits, nonce }
}

function headerFromJson(body: RawHeaderJson, fallbackHeight: number): BlockHeaderInfo {
  const height = coerceInt(body.height) ?? fallbackHeight
  const previousHash = coerceHashHex(body.previousHash)
  const merkleRoot = coerceHashHex(body.merkleRoot)
  const hash = coerceHashHex(body.hash)
  const bits = coerceInt(body.bits)
  if (!previousHash || !merkleRoot || !hash || bits == null) {
    throw new Error('Chaintracks returned an incomplete header')
  }
  return {
    height,
    hash,
    previousHash,
    merkleRoot,
    version: coerceInt(body.version) ?? 0,
    time: coerceInt(body.time) ?? 0,
    bits,
    nonce: coerceInt(body.nonce) ?? 0,
  }
}

async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS)
  try {
    return await fetch(url, { headers: { Accept: accept }, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * One header by height, or `null` when Chaintracks does not have it.
 *
 * Concurrent callers for the same height share one request: the verifier can
 * meet several transactions mined in the same block, and one header answers all
 * of them.
 */
export async function getHeaderByHeight(height: number): Promise<BlockHeaderInfo | null> {
  if (!Number.isSafeInteger(height) || height < 0) return null

  const cached = headerCache.get(height)
  if (cached) {
    // Refresh recency so a hot height is not evicted while in use.
    headerCache.delete(height)
    headerCache.set(height, cached)
    return cached
  }

  const inFlight = inFlightHeaderRequests.get(height)
  if (inFlight) return inFlight

  const request = (async (): Promise<BlockHeaderInfo | null> => {
    const response = await fetchWithTimeout(
      v2Url(getChaintracksBaseUrl(), `/header/height/${height}`),
      'application/json',
    )
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Chaintracks header ${height} returned HTTP ${response.status}`)
    }
    const body = (await response.json().catch(() => null)) as RawHeaderJson | null
    if (!body || typeof body !== 'object') return null
    const header = headerFromJson(body, height)
    if (header.height !== height) {
      // A height mismatch means the response is not the header that was asked for.
      throw new Error(`Chaintracks returned height ${header.height} for a request at ${height}`)
    }
    cacheHeader(header)
    return header
  })()

  inFlightHeaderRequests.set(height, request)
  try {
    return await request
  } finally {
    inFlightHeaderRequests.delete(height)
  }
}

/**
 * A contiguous run of raw headers, `count` of them starting at `startHeight`.
 *
 * Reads `/headers.bin`, which returns exactly `count * 80` bytes. Batching
 * matters to the verifier: a reorg check needs the whole span between two
 * blocks, and one request is far cheaper than the same number of single reads.
 */
export async function getHeaderBatch(
  startHeight: number,
  count: number,
): Promise<BlockHeaderInfo[]> {
  if (!Number.isSafeInteger(startHeight) || startHeight < 0) {
    throw new Error('startHeight must be a non-negative integer')
  }
  const total = Math.min(Math.max(1, Math.floor(count)), MAX_HEADER_BATCH)

  const response = await fetchWithTimeout(
    v2Url(getChaintracksBaseUrl(), `/headers.bin?height=${startHeight}&count=${total}`),
    'application/octet-stream',
  )
  if (!response.ok) {
    throw new Error(
      `Chaintracks headers.bin ${startHeight}+${total} returned HTTP ${response.status}`,
    )
  }
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.length === 0) return []
  if (buffer.length % HEADER_BYTES !== 0) {
    throw new Error(
      `Chaintracks headers.bin returned ${buffer.length} bytes, not a multiple of ${HEADER_BYTES}`,
    )
  }
  if (buffer.length > total * HEADER_BYTES) {
    throw new Error(
      `Chaintracks headers.bin returned ${buffer.length / HEADER_BYTES} headers for a request of ${total}`,
    )
  }

  const headers: BlockHeaderInfo[] = []
  for (let index = 0; index < buffer.length / HEADER_BYTES; index++) {
    const header = decodeRawHeader(buffer, index * HEADER_BYTES, startHeight + index)
    headers.push(header)
    cacheHeader(header)
  }
  return headers
}

/** Current chain tip height, or `null` when Chaintracks cannot be reached. */
export async function getChaintracksHeight(): Promise<number | null> {
  try {
    const response = await fetchWithTimeout(
      v2Url(getChaintracksBaseUrl(), '/height'),
      'application/json',
    )
    if (!response.ok) return null
    const body = (await response.json().catch(() => null)) as { height?: unknown } | null
    return coerceInt(body?.height)
  } catch {
    return null
  }
}

/**
 * Decode a `bits` compact target into a full 256-bit target.
 *
 * Mirrors Bitcoin's `nBits` encoding: one exponent byte, then a 24-bit mantissa.
 * The sign bit is ignored — a negative target is not something a valid header
 * can carry, and honouring one would accept fabricated work.
 */
export function bitsToTarget(bits: number): bigint {
  const exponent = (bits >>> 24) & 0xff
  const mantissa = bits & 0x007fffff
  let target = BigInt(mantissa)
  if (exponent <= 3) {
    target >>= BigInt(8 * (3 - exponent))
  } else {
    target <<= BigInt(8 * (exponent - 3))
  }
  return target
}

/** True when the header's hash is at or below the target its `bits` states. */
export function headerMeetsTarget(header: BlockHeaderInfo): boolean {
  const target = bitsToTarget(header.bits)
  if (target <= BigInt(0)) return false
  return BigInt(`0x${header.hash}`) <= target
}

/**
 * Verify that a run of headers is a chain.
 *
 * For every header: its hash is below its stated target, and — where a
 * neighbour is present — `previousHash` matches the parent's hash. Ordering is
 * by ascending height; a gap breaks the linkage claim, so a non-contiguous
 * batch is rejected with the offending height.
 *
 * This turns "a host told me this header" into "this header is part of a chain
 * of work". It cannot detect a well-formed fork — that needs a checkpoint or a
 * trusted tip — which is why `spvVerified` also depends on the header's source.
 */
export function verifyHeaderChainLinkage(headers: BlockHeaderInfo[]): HeaderChainLinkageResult {
  if (headers.length === 0) {
    return { linked: false, workValid: false, reason: 'no headers supplied' }
  }

  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]
    if (!headerMeetsTarget(header)) {
      return {
        linked: false,
        workValid: false,
        failedAtHeight: header.height,
        reason: `header ${header.height} does not satisfy its proof-of-work target`,
      }
    }
    if (index > 0) {
      const parent = headers[index - 1]
      if (header.height !== parent.height + 1) {
        return {
          linked: false,
          workValid: true,
          failedAtHeight: header.height,
          reason: `headers jump from ${parent.height} to ${header.height}`,
        }
      }
      if (header.previousHash !== parent.hash) {
        return {
          linked: false,
          workValid: true,
          failedAtHeight: header.height,
          reason: `header ${header.height} does not link to header ${parent.height}`,
        }
      }
    }
  }

  return { linked: true, workValid: true }
}

/**
 * Re-hash a header from its fields and confirm the claimed hash is really its
 * hash.
 *
 * A host returning a JSON header supplies both the bytes and the digest; a
 * mismatch means at least one is fabricated. This re-serialises the six fields
 * a header is defined by and compares.
 */
export function recomputeHeaderHash(header: BlockHeaderInfo): string {
  const buffer = Buffer.alloc(HEADER_BYTES)
  buffer.writeUInt32LE(header.version >>> 0, 0)
  Buffer.from(header.previousHash, 'hex').reverse().copy(buffer, 4)
  Buffer.from(header.merkleRoot, 'hex').reverse().copy(buffer, 36)
  buffer.writeUInt32LE(header.time >>> 0, 68)
  buffer.writeUInt32LE(header.bits >>> 0, 72)
  buffer.writeUInt32LE(header.nonce >>> 0, 76)
  return hashHeaderBytes(buffer)
}

/**
 * Prove a header against its predecessor: its own bytes hash to its claimed
 * hash, it satisfies its own target, and it links to a parent that also
 * satisfies its target.
 *
 * Results are remembered, so a height proven once is not re-proven for the next
 * transaction in the same block.
 */
export async function verifyHeaderAgainstParent(
  header: BlockHeaderInfo,
): Promise<{ linked: boolean; workValid: boolean; parentVerified: boolean; reason?: string }> {
  const selfHash = recomputeHeaderHash(header)
  if (selfHash !== header.hash) {
    return {
      linked: false,
      workValid: false,
      parentVerified: false,
      reason: `header ${header.height} hashes to ${selfHash.slice(0, 16)}…, not its claimed ${header.hash.slice(0, 16)}…`,
    }
  }
  if (!headerMeetsTarget(header)) {
    return {
      linked: false,
      workValid: false,
      parentVerified: false,
      reason: `header ${header.height} does not satisfy its proof-of-work target`,
    }
  }

  if (locallyVerifiedHeights.has(header.height)) {
    return { linked: true, workValid: true, parentVerified: true }
  }

  if (header.height === 0) {
    // Genesis has no predecessor to link to. Its own work check stands alone.
    locallyVerifiedHeights.add(0)
    return { linked: true, workValid: true, parentVerified: true }
  }

  let parent: BlockHeaderInfo | null = null
  try {
    parent = await getHeaderByHeight(header.height - 1)
  } catch (error) {
    return {
      linked: false,
      workValid: true,
      parentVerified: false,
      reason: `could not fetch header ${header.height - 1}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
  if (!parent) {
    return {
      linked: false,
      workValid: true,
      parentVerified: false,
      reason: `header ${header.height - 1} is unavailable from Chaintracks`,
    }
  }
  if (parent.hash !== header.previousHash) {
    return {
      linked: false,
      workValid: true,
      parentVerified: false,
      reason: `header ${header.height} points at ${header.previousHash.slice(0, 16)}… but header ${
        header.height - 1
      } hashes to ${parent.hash.slice(0, 16)}…`,
    }
  }
  if (!headerMeetsTarget(parent)) {
    return {
      linked: true,
      workValid: true,
      parentVerified: false,
      reason: `header ${parent.height} does not satisfy its proof-of-work target`,
    }
  }

  locallyVerifiedHeights.add(header.height)
  locallyVerifiedHeights.add(parent.height)
  return { linked: true, workValid: true, parentVerified: true }
}

/**
 * True when this height was proven by local linkage. This is the only condition
 * under which a caller may set `spv_verified = true`.
 */
export function isLocallyVerified(height: number): boolean {
  return locallyVerifiedHeights.has(height)
}

/**
 * A `ChainTracker` for `@bsv/sdk`'s own verification paths.
 *
 * `isValidRootForHeight` compares a merkle root to the header at that height.
 * It reports that weaker fact and does not claim chain membership, which is
 * what `verifyHeaderAgainstParent` is for.
 */
export function createChaintracksChainTracker(): {
  isValidRootForHeight: (root: string, height: number) => Promise<boolean>
  currentHeight: () => Promise<number>
} {
  return {
    isValidRootForHeight: async (root: string, height: number): Promise<boolean> => {
      const expected = String(root ?? '').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(expected)) return false
      const header = await getHeaderByHeight(height)
      if (!header) return false
      return header.merkleRoot === expected
    },
    currentHeight: async (): Promise<number> => {
      const height = await getChaintracksHeight()
      return height ?? 0
    },
  }
}

/** Fetch a header by its hash, or `null`. Useful when a proof names a block. */
export async function getHeaderByHash(hash: string): Promise<BlockHeaderInfo | null> {
  const normalised = String(hash ?? '').trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalised)) return null
  for (const header of headerCache.values()) {
    if (header.hash === normalised) return header
  }
  try {
    const response = await fetchWithTimeout(
      v2Url(getChaintracksBaseUrl(), `/header/hash/${normalised}`),
      'application/json',
    )
    if (response.status === 404) return null
    if (!response.ok) return null
    const body = (await response.json().catch(() => null)) as RawHeaderJson | null
    if (!body || typeof body !== 'object') return null
    const header = headerFromJson(body, 0)
    if (header.hash !== normalised) return null
    cacheHeader(header)
    return header
  } catch {
    return null
  }
}

/** Test and diagnostic helper. */
export function resetChaintracksCache(): void {
  headerCache.clear()
  locallyVerifiedHeights.clear()
  inFlightHeaderRequests.clear()
}
