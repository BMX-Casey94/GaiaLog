import * as bsv from 'bsv'
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'
import { AuthFetch } from '@bsv/sdk/auth'
import { ProtoWallet } from '@bsv/sdk/wallet'
import { bsvConfig } from './bsv-config'
import { getOverlayClientAuthConfig, getOverlayFallbackConfig } from './overlay-config'
import { spendSourceObservability } from './spend-source-observability'
import { getReservedUtxoKeys } from './utxo-locks'
import { getUnspentForAddress } from './utxo-provider'
import { walletManager } from './wallet-manager'

export type SpendSourceMode = 'legacy' | 'shadow' | 'overlay'
export type SpendableOrder = 'asc' | 'desc'
export type SubmitAckStatus = 'ack' | 'nack' | 'pending' | 'skipped'

export interface CountSpendableInput {
  topic: string
  minSatoshis?: number
  excludeReserved?: boolean
  confirmedOnly?: boolean
  allowDegradedStale?: boolean
}

export interface ListSpendableInput extends CountSpendableInput {
  limit: number
  order?: SpendableOrder
}

export interface SpendableOutput {
  topic: string
  walletIndex: number | null
  address: string | null
  txid: string
  vout: number
  outputScript: string
  satoshis: number
  rawTx: string | null
  proof: unknown | null
  confirmed: boolean
  admittedAt: string | null
  source: 'legacy' | 'overlay'
}

export interface SubmitAcceptedTxInput {
  clientRequestId: string
  rawTxEnvelope: unknown
  topics: string[]
  requireAllHostAcks?: boolean
}

export interface SubmitAcceptedTxResult {
  clientRequestId: string
  ackSummary: Record<string, SubmitAckStatus>
  allHostsAcknowledged: boolean
  accepted: boolean
}

export interface SpendSource {
  countSpendable(input: CountSpendableInput): Promise<number>
  listSpendable(input: ListSpendableInput): Promise<SpendableOutput[]>
  submitAcceptedTx(input: SubmitAcceptedTxInput): Promise<SubmitAcceptedTxResult>
}

export interface SpendSourceConfig {
  mode: SpendSourceMode
  shadowReadsEnabled: boolean
  legacyFallbackEnabled: boolean
  confirmedOnlyDefault: boolean
  canaryWalletIndex: number | null
  forcedLegacyWalletIndexes: number[]
  topicPrefix: string
  topicVersion: string
  overlayProviderId: string
  overlayLookupConfigured: boolean
  overlaySubmitConfigured: boolean
  overlayRequireAllHostAcks: boolean
  treasuryTopics: string[]
}

export interface SpendSourceStatus extends SpendSourceConfig {
  overlayImplemented: boolean
  activeImplementation: 'legacy' | 'shadow-legacy' | 'overlay' | 'overlay-unavailable'
  wallets: Array<{
    walletIndex: number
    walletLabel: string
    topic: string
    forcedLegacy: boolean
    temporaryFallbackActive: boolean
    temporaryFallbackUntil: number | null
    lastFallbackReason: string | null
    fallbackCount: number
    overlaySelected: boolean
  }>
}

export interface TreasuryTopicRef {
  topic: string
  prefix: string
  version: string
  walletIndex: number
  walletLabel: string
}

interface OverlayHttpConfig {
  providerId: string
  lookupUrl: string | null
  submitUrl: string | null
  lookupHeaders: Record<string, string>
  submitHeaders: Record<string, string>
  timeoutMs: number
  maxRetries: number
  countFallbackLimit: number
}

type LegacyWalletSpendable = SpendableOutput & {
  utxoKey: string
}

const DEFAULT_TOPIC_PREFIX = 'TREASURY'
const DEFAULT_TOPIC_VERSION = 'v1'
const DEFAULT_OVERLAY_PROVIDER_ID = 'donations-lookup'
const DEFAULT_LIST_LIMIT = 200
const DEFAULT_MIN_CONF = Math.max(1, Number(process.env.BSV_UTXO_MIN_CONFIRMATIONS || 1))
const LEGACY_SUBMIT_WARN_KEY = '__GAIALOG_LEGACY_SPEND_SOURCE_SUBMIT_WARNED__'
const OVERLAY_COUNT_FALLBACK_WARN_KEY = '__GAIALOG_OVERLAY_COUNT_FALLBACK_WARNED__'
const OVERLAY_FALLBACK_WARN_KEY = '__GAIALOG_OVERLAY_SPEND_SOURCE_FALLBACK_WARNED__'
const SHADOW_LOG_INTERVAL_MS = 60_000

const shadowLogAtByTopic = new Map<string, number>()
let overlayAuthFetchSingleton: AuthFetch | null | undefined

type WalletFallbackState = {
  lookupFailures: number
  submitFailures: number
  fallbackUntil: number
  lastFallbackReason: string | null
  lastFallbackAt: number | null
  fallbackCount: number
}

const walletFallbackStateByIndex = new Map<number, WalletFallbackState>()

function getWalletFallbackState(walletIndex: number): WalletFallbackState {
  let state = walletFallbackStateByIndex.get(walletIndex)
  if (!state) {
    state = {
      lookupFailures: 0,
      submitFailures: 0,
      fallbackUntil: 0,
      lastFallbackReason: null,
      lastFallbackAt: null,
      fallbackCount: 0,
    }
    walletFallbackStateByIndex.set(walletIndex, state)
  }
  return state
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function parseSpendSourceMode(value: string | undefined): SpendSourceMode {
  switch (String(value || '').trim().toLowerCase()) {
    case 'shadow':
      return 'shadow'
    case 'overlay':
      return 'overlay'
    default:
      return 'legacy'
  }
}

function parseOptionalIndex(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.floor(parsed)
}

function getConfiguredWalletCount(): number {
  const fromManager = walletManager.getWalletCount()
  if (fromManager > 0) return fromManager
  return Math.max(0, bsvConfig.wallets.privateKeys.length)
}

function normaliseTopicPrefix(value: string | undefined): string {
  const safe = String(value || DEFAULT_TOPIC_PREFIX).trim()
  return safe ? safe.toUpperCase() : DEFAULT_TOPIC_PREFIX
}

function normaliseTopicVersion(value: string | undefined): string {
  const safe = String(value || DEFAULT_TOPIC_VERSION).trim()
  return safe || DEFAULT_TOPIC_VERSION
}

function compareSpendables(left: LegacyWalletSpendable, right: LegacyWalletSpendable, order: SpendableOrder): number {
  const direction = order === 'desc' ? -1 : 1
  if (left.satoshis !== right.satoshis) {
    return direction * (left.satoshis - right.satoshis)
  }
  const txidCmp = left.txid.localeCompare(right.txid)
  if (txidCmp !== 0) return direction * txidCmp
  return direction * (left.vout - right.vout)
}

function isLegacyUtxoConfirmed(utxo: any, minConf: number = DEFAULT_MIN_CONF): boolean {
  const confirmations = Number(utxo?.confirmations || 0)
  const height = typeof utxo?.height === 'number' ? utxo.height : null
  return confirmations >= minConf || (height != null && height > 0)
}

function getOutputScriptHex(address: string): string {
  try {
    const fromAddress = (bsv.Script as any).fromAddress
    if (fromAddress) return fromAddress(address).toHex()
  } catch {
    // Fall through to empty script for unsupported address formats.
  }
  return ''
}

function getWalletAddress(walletIndex: number): string | null {
  const address = walletManager.getWalletAddress(walletIndex)
  return address || null
}

function parseHeadersJson(value: string | undefined): Record<string, string> {
  if (!value || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).map(([key, val]) => [String(key), String(val)])
    )
  } catch {
    return {}
  }
}

function getOverlayHttpConfig(): OverlayHttpConfig {
  const sharedHeaders = parseHeadersJson(process.env.BSV_OVERLAY_HEADERS_JSON)
  return {
    providerId: String(process.env.BSV_OVERLAY_PROVIDER_ID || DEFAULT_OVERLAY_PROVIDER_ID).trim() || DEFAULT_OVERLAY_PROVIDER_ID,
    lookupUrl: String(process.env.BSV_OVERLAY_LOOKUP_URL || '').trim() || null,
    submitUrl: String(process.env.BSV_OVERLAY_SUBMIT_URL || '').trim() || null,
    lookupHeaders: {
      ...sharedHeaders,
      ...parseHeadersJson(process.env.BSV_OVERLAY_LOOKUP_HEADERS_JSON),
    },
    submitHeaders: {
      ...sharedHeaders,
      ...parseHeadersJson(process.env.BSV_OVERLAY_SUBMIT_HEADERS_JSON),
    },
    timeoutMs: Math.max(1000, Number(process.env.BSV_OVERLAY_TIMEOUT_MS || 15000)),
    maxRetries: Math.max(0, Number(process.env.BSV_OVERLAY_MAX_RETRIES || 3)),
    countFallbackLimit: Math.max(0, Number(process.env.BSV_OVERLAY_COUNT_FALLBACK_LIMIT || 5000)),
  }
}

function getOverlayAuthFetch(): AuthFetch | null {
  if (overlayAuthFetchSingleton !== undefined) return overlayAuthFetchSingleton

  const authConfig = getOverlayClientAuthConfig()
  if (authConfig.mode !== 'brc104') {
    console.log(`💸 Spend source: overlay auth mode=${authConfig.mode} (no AuthFetch)`)
    overlayAuthFetchSingleton = null
    return overlayAuthFetchSingleton
  }

  if (!authConfig.identityWif) {
    throw new Error('BSV_OVERLAY_CLIENT_IDENTITY_WIF is required when BSV_OVERLAY_AUTH_MODE=brc104')
  }

  console.log('💸 Spend source: overlay auth mode=brc104 (AuthFetch enabled)')
  overlayAuthFetchSingleton = new AuthFetch(
    new ProtoWallet(SDKPrivateKey.fromWif(authConfig.identityWif)) as any,
  )
  return overlayAuthFetchSingleton
}

function assertOverlayAuthHeadersSupported(headers: Record<string, string>): void {
  const authFetch = getOverlayAuthFetch()
  if (!authFetch) return

  for (const key of Object.keys(headers)) {
    const safe = key.toLowerCase()
    if (safe === 'authorization' || safe === 'content-type' || safe.startsWith('x-bsv-')) continue
    throw new Error(
      `Unsupported overlay header "${key}" for BRC-104 requests. Use "authorization" or "x-bsv-*" headers only.`,
    )
  }
}

function parseSubmitEnvelope(rawTxEnvelope: unknown): {
  txid?: string
  rawTx?: string
  prevouts?: unknown
  mapiResponses?: unknown
  beef?: unknown
  proof?: unknown
} {
  if (!rawTxEnvelope || typeof rawTxEnvelope !== 'object') return {}
  const input = rawTxEnvelope as Record<string, unknown>
  return {
    txid: typeof input.txid === 'string' ? input.txid : undefined,
    rawTx: typeof input.rawTx === 'string' ? input.rawTx : undefined,
    prevouts: input.prevouts,
    mapiResponses: input.mapiResponses,
    beef: input.beef,
    proof: input.proof,
  }
}

function isWalletForcedLegacy(walletIndex: number): boolean {
  return getOverlayFallbackConfig().forcedLegacyWalletIndexes.includes(walletIndex)
}

function isWalletTemporarilyFallback(walletIndex: number): boolean {
  const state = getWalletFallbackState(walletIndex)
  if (state.fallbackUntil <= Date.now()) {
    state.fallbackUntil = 0
    return false
  }
  return true
}

function registerOverlayWalletSuccess(walletIndex: number, kind: 'lookup' | 'submit'): void {
  const state = getWalletFallbackState(walletIndex)
  if (kind === 'lookup') state.lookupFailures = 0
  else state.submitFailures = 0
}

function registerOverlayWalletFailure(walletIndex: number, kind: 'lookup' | 'submit', reason: string): void {
  const state = getWalletFallbackState(walletIndex)
  const config = getOverlayFallbackConfig()
  if (kind === 'lookup') state.lookupFailures += 1
  else state.submitFailures += 1

  const failureCount = Math.max(state.lookupFailures, state.submitFailures)
  if (failureCount < config.failureThreshold) return

  state.lookupFailures = 0
  state.submitFailures = 0
  state.fallbackUntil = Date.now() + config.fallbackCooldownMs
  state.lastFallbackReason = reason
  state.lastFallbackAt = Date.now()
  state.fallbackCount += 1
  console.warn(
    `⚠️ Overlay spend-source fallback activated for W${walletIndex + 1} until ${new Date(state.fallbackUntil).toISOString()}: ${reason}`,
  )
}

function extractLookupItems(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.outputs)) return payload.outputs
  if (Array.isArray(payload?.items)) return payload.items
  if (Array.isArray(payload?.results)) return payload.results
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function extractLookupTotal(payload: any): number | null {
  const candidates = [
    payload?.total,
    payload?.count,
    payload?.meta?.total,
    payload?.meta?.count,
    payload?.pagination?.total,
  ]
  for (const candidate of candidates) {
    const n = Number(candidate)
    if (Number.isFinite(n) && n >= 0) return Math.floor(n)
  }
  return null
}

function normaliseAckStatus(value: unknown): SubmitAckStatus {
  const safe = String(value || '').trim().toLowerCase()
  if (safe === 'ack' || safe === 'accepted' || safe === 'ok' || safe === 'success' || safe === 'true') return 'ack'
  if (safe === 'nack' || safe === 'rejected' || safe === 'error' || safe === 'false') return 'nack'
  if (safe === 'pending' || safe === 'queued' || safe === 'processing') return 'pending'
  return 'skipped'
}

function normaliseAckSummary(payload: any): Record<string, SubmitAckStatus> {
  const fromObject = payload?.ackSummary
  if (fromObject && typeof fromObject === 'object' && !Array.isArray(fromObject)) {
    return Object.fromEntries(
      Object.entries(fromObject).map(([host, status]) => [String(host), normaliseAckStatus(status)])
    )
  }
  if (Array.isArray(payload?.acks)) {
    return Object.fromEntries(
      payload.acks.map((entry: any, index: number) => [
        String(entry?.host || entry?.name || `host_${index + 1}`),
        normaliseAckStatus(entry?.status),
      ])
    )
  }
  if (Array.isArray(payload?.hosts)) {
    return Object.fromEntries(
      payload.hosts.map((entry: any, index: number) => [
        String(entry?.host || entry?.name || `host_${index + 1}`),
        normaliseAckStatus(entry?.status),
      ])
    )
  }
  return {}
}

function shouldLogShadowDrift(topic: string): boolean {
  const now = Date.now()
  const last = shadowLogAtByTopic.get(topic) || 0
  if ((now - last) < SHADOW_LOG_INTERVAL_MS) return false
  shadowLogAtByTopic.set(topic, now)
  return true
}

function outpointKey(output: Pick<SpendableOutput, 'txid' | 'vout'>): string {
  return `${output.txid}:${output.vout}`
}

function safeParseJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function postJsonWithRetry(
  kind: 'lookup' | 'submit',
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  maxRetries: number,
  metricTopics: string[] = [],
): Promise<any> {
  let attempt = 0
  let lastError: Error | null = null
  while (attempt <= maxRetries) {
    const startedAt = Date.now()
    try {
      const requestHeaders = {
        'content-type': 'application/json',
        ...headers,
      }
      assertOverlayAuthHeadersSupported(requestHeaders)

      const authFetch = getOverlayAuthFetch()
      const response = authFetch
        ? await new Promise<Response>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error(`Overlay ${kind} timed out after ${timeoutMs}ms`))
            }, timeoutMs)

            authFetch.fetch(url, {
              method: 'POST',
              headers: requestHeaders,
              body,
            })
              .then((value) => {
                clearTimeout(timeoutId)
                resolve(value)
              })
              .catch((error) => {
                clearTimeout(timeoutId)
                reject(error)
              })
          })
        : await (async () => {
            const controller = new AbortController()
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
            try {
              return await fetch(url, {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify(body),
                signal: controller.signal,
              })
            } finally {
              clearTimeout(timeoutId)
            }
          })()
      const text = await response.text().catch(() => '')
      const elapsedMs = Date.now() - startedAt
      const ok = response.ok
      if (kind === 'lookup') {
        spendSourceObservability.recordLookup(elapsedMs, ok)
        if (metricTopics[0]) spendSourceObservability.recordLookupForTopic(metricTopics[0], elapsedMs, ok)
      }
      else {
        spendSourceObservability.recordSubmit(elapsedMs, ok)
        for (const topic of metricTopics) {
          spendSourceObservability.recordSubmitForTopic(topic, elapsedMs, ok)
        }
      }

      if (response.ok) {
        return text ? safeParseJson(text) : {}
      }

      lastError = new Error(`HTTP ${response.status} ${text || response.statusText}`.trim())
      if (!(response.status === 429 || response.status >= 500) || attempt >= maxRetries) {
        throw lastError
      }
    } catch (error) {
      if (!lastError) lastError = error instanceof Error ? error : new Error(String(error))
      const elapsedMs = Date.now() - startedAt
      if (kind === 'lookup') {
        spendSourceObservability.recordLookup(elapsedMs, false)
        if (metricTopics[0]) spendSourceObservability.recordLookupForTopic(metricTopics[0], elapsedMs, false)
      }
      else {
        spendSourceObservability.recordSubmit(elapsedMs, false)
        for (const topic of metricTopics) {
          spendSourceObservability.recordSubmitForTopic(topic, elapsedMs, false)
        }
      }

      if (attempt >= maxRetries) throw lastError
      const delay = Math.min(5000, 250 * Math.pow(2, attempt)) + Math.floor(Math.random() * 100)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    attempt += 1
  }
  throw lastError || new Error(`Overlay ${kind} failed`)
}

export function buildTreasuryTopic(walletIndex: number, overrides?: { topicPrefix?: string; topicVersion?: string }): string {
  const safeIndex = Math.max(0, Math.floor(walletIndex))
  const prefix = normaliseTopicPrefix(overrides?.topicPrefix)
  const version = normaliseTopicVersion(overrides?.topicVersion)
  return `${prefix}:${version}:W${safeIndex + 1}`
}

export function getConfiguredTreasuryTopics(walletCount: number = getConfiguredWalletCount()): string[] {
  const config = getSpendSourceConfig()
  return Array.from({ length: Math.max(0, walletCount) }, (_, walletIndex) =>
    buildTreasuryTopic(walletIndex, {
      topicPrefix: config.topicPrefix,
      topicVersion: config.topicVersion,
    })
  )
}

export function resolveTreasuryTopic(topic: string, config: SpendSourceConfig = getSpendSourceConfig()): TreasuryTopicRef {
  const safe = String(topic || '').trim()
  const match = /^([^:]+):([^:]+):W(\d+)$/i.exec(safe)
  if (!match) {
    throw new Error(`Unsupported treasury topic "${topic}"`)
  }
  const prefix = normaliseTopicPrefix(match[1])
  const version = normaliseTopicVersion(match[2])
  const walletNumber = Number(match[3])
  const walletIndex = Math.max(0, walletNumber - 1)
  if (prefix !== config.topicPrefix || version !== config.topicVersion) {
    throw new Error(`Treasury topic "${topic}" does not match configured namespace ${config.topicPrefix}:${config.topicVersion}`)
  }
  if (walletIndex >= getConfiguredWalletCount()) {
    throw new Error(`Treasury topic "${topic}" resolves to wallet index ${walletIndex}, but only ${getConfiguredWalletCount()} wallet(s) are configured`)
  }
  return {
    topic: buildTreasuryTopic(walletIndex, { topicPrefix: prefix, topicVersion: version }),
    prefix,
    version,
    walletIndex,
    walletLabel: `W${walletIndex + 1}`,
  }
}

export function getTreasuryTopicForWallet(walletIndex: number): string {
  const config = getSpendSourceConfig()
  return buildTreasuryTopic(walletIndex, {
    topicPrefix: config.topicPrefix,
    topicVersion: config.topicVersion,
  })
}

export function getWalletIndexForAddress(address: string): number | null {
  const addresses = walletManager.getAllWalletAddresses()
  const index = addresses.findIndex(candidate => candidate === address)
  return index >= 0 ? index : null
}

export function getTreasuryTopicForAddress(address: string): string | null {
  const walletIndex = getWalletIndexForAddress(address)
  return walletIndex == null ? null : getTreasuryTopicForWallet(walletIndex)
}

export function getSpendSourceConfig(): SpendSourceConfig {
  const overlay = getOverlayHttpConfig()
  const fallbackConfig = getOverlayFallbackConfig()
  const topicPrefix = normaliseTopicPrefix(process.env.BSV_OVERLAY_TOPIC_PREFIX)
  const topicVersion = normaliseTopicVersion(process.env.BSV_OVERLAY_TOPIC_VERSION)
  const walletCount = getConfiguredWalletCount()
  return {
    mode: parseSpendSourceMode(process.env.BSV_SPEND_SOURCE_MODE),
    shadowReadsEnabled: parseBool(process.env.BSV_SPEND_SOURCE_SHADOW_READS, true),
    legacyFallbackEnabled: parseBool(process.env.BSV_SPEND_SOURCE_LEGACY_FALLBACK_ENABLED, true),
    confirmedOnlyDefault: parseBool(process.env.BSV_OVERLAY_CONFIRMED_ONLY, true),
    canaryWalletIndex: parseOptionalIndex(process.env.BSV_OVERLAY_CANARY_WALLET),
    forcedLegacyWalletIndexes: fallbackConfig.forcedLegacyWalletIndexes,
    topicPrefix,
    topicVersion,
    overlayProviderId: overlay.providerId,
    overlayLookupConfigured: !!overlay.lookupUrl,
    overlaySubmitConfigured: !!overlay.submitUrl,
    overlayRequireAllHostAcks: parseBool(process.env.BSV_OVERLAY_REQUIRE_ALL_HOST_ACKS, false),
    treasuryTopics: Array.from({ length: walletCount }, (_, walletIndex) =>
      buildTreasuryTopic(walletIndex, { topicPrefix, topicVersion })
    ),
  }
}

export function getSpendSourceStatus(): SpendSourceStatus {
  const config = getSpendSourceConfig()
  const overlayUsable = config.overlayLookupConfigured && config.overlaySubmitConfigured
  let activeImplementation: SpendSourceStatus['activeImplementation'] = 'legacy'
  if (config.mode === 'shadow' && overlayUsable) activeImplementation = 'shadow-legacy'
  else if (config.mode === 'overlay' && overlayUsable) activeImplementation = 'overlay'
  else if (config.mode === 'overlay') activeImplementation = 'overlay-unavailable'

  return {
    ...config,
    overlayImplemented: true,
    activeImplementation,
    wallets: Array.from({ length: getConfiguredWalletCount() }, (_, walletIndex) => {
      const topic = buildTreasuryTopic(walletIndex, {
        topicPrefix: config.topicPrefix,
        topicVersion: config.topicVersion,
      })
      const state = getWalletFallbackState(walletIndex)
      const temporaryFallbackActive = isWalletTemporarilyFallback(walletIndex)
      const forcedLegacy = isWalletForcedLegacy(walletIndex)
      return {
        walletIndex,
        walletLabel: `W${walletIndex + 1}`,
        topic,
        forcedLegacy,
        temporaryFallbackActive,
        temporaryFallbackUntil: temporaryFallbackActive ? state.fallbackUntil : null,
        lastFallbackReason: state.lastFallbackReason,
        fallbackCount: state.fallbackCount,
        overlaySelected: config.mode === 'overlay' && overlayUsable && !forcedLegacy && !temporaryFallbackActive
          && (config.canaryWalletIndex == null || config.canaryWalletIndex === walletIndex),
      }
    }),
  }
}

async function getLegacyWalletSpendables(input: CountSpendableInput): Promise<LegacyWalletSpendable[]> {
  const config = getSpendSourceConfig()
  const resolvedTopic = resolveTreasuryTopic(input.topic, config)
  const address = getWalletAddress(resolvedTopic.walletIndex)
  if (!address) {
    throw new Error(`No wallet address configured for ${resolvedTopic.walletLabel}`)
  }

  const minSatoshis = Math.max(0, Number(input.minSatoshis || 0))
  const confirmedOnly = input.confirmedOnly ?? config.confirmedOnlyDefault
  const utxos = await getUnspentForAddress(address, { allowDegradedStale: input.allowDegradedStale })
  const outputScript = getOutputScriptHex(address)

  let spendables: LegacyWalletSpendable[] = (Array.isArray(utxos) ? utxos : [])
    .map((utxo: any) => {
      const txid = String(utxo?.tx_hash || utxo?.txid || '')
      const vout = Number(utxo?.tx_pos ?? utxo?.vout ?? 0)
      const satoshis = Number(utxo?.value ?? utxo?.satoshis ?? 0)
      const confirmed = isLegacyUtxoConfirmed(utxo)
      return {
        topic: resolvedTopic.topic,
        walletIndex: resolvedTopic.walletIndex,
        address,
        txid,
        vout,
        outputScript,
        satoshis,
        rawTx: null,
        proof: null,
        confirmed,
        admittedAt: null,
        source: 'legacy' as const,
        utxoKey: `${txid}:${vout}`,
      }
    })
    .filter(output => output.txid.length > 0 && output.satoshis >= minSatoshis)

  if (confirmedOnly) {
    spendables = spendables.filter(output => output.confirmed)
  }

  if (input.excludeReserved) {
    const reservedKeys = new Set(await getReservedUtxoKeys(spendables.map(output => output.utxoKey)))
    spendables = spendables.filter(output => !reservedKeys.has(output.utxoKey))
  }

  return spendables
}

class LegacySpendSource implements SpendSource {
  async countSpendable(input: CountSpendableInput): Promise<number> {
    const spendables = await getLegacyWalletSpendables(input)
    return spendables.length
  }

  async listSpendable(input: ListSpendableInput): Promise<SpendableOutput[]> {
    const order = input.order === 'desc' ? 'desc' : 'asc'
    const limit = Math.max(0, Math.floor(Number.isFinite(input.limit) ? input.limit : DEFAULT_LIST_LIMIT))
    const spendables = await getLegacyWalletSpendables(input)
    return spendables
      .sort((left, right) => compareSpendables(left, right, order))
      .slice(0, limit)
      .map(({ utxoKey: _utxoKey, ...output }) => output)
  }

  async submitAcceptedTx(input: SubmitAcceptedTxInput): Promise<SubmitAcceptedTxResult> {
    const warnedKey = LEGACY_SUBMIT_WARN_KEY
    const globalState = globalThis as any
    if (!globalState[warnedKey]) {
      globalState[warnedKey] = true
      console.warn('⚠️ SpendSource.submitAcceptedTx() called while only the legacy spend source is active; submission was skipped.')
    }
    return {
      clientRequestId: input.clientRequestId,
      ackSummary: { legacy: 'skipped' },
      allHostsAcknowledged: false,
      accepted: false,
    }
  }
}

class OverlayHttpSpendSource implements SpendSource {
  private getOverlayTopicDefaults(topic: string): { walletIndex: number | null; address: string | null; outputScript: string } {
    try {
      const resolved = resolveTreasuryTopic(topic)
      const address = getWalletAddress(resolved.walletIndex)
      return {
        walletIndex: resolved.walletIndex,
        address,
        outputScript: address ? getOutputScriptHex(address) : '',
      }
    } catch {
      return {
        walletIndex: null,
        address: null,
        outputScript: '',
      }
    }
  }

  private buildLookupBody(input: CountSpendableInput | ListSpendableInput, limitOverride?: number): Record<string, unknown> {
    const config = getSpendSourceConfig()
    const overlay = getOverlayHttpConfig()
    const effectiveLimit = typeof limitOverride === 'number'
      ? limitOverride
      : ('limit' in input ? input.limit : DEFAULT_LIST_LIMIT)
    return {
      provider: overlay.providerId,
      query: {
        topic: input.topic,
        minSatoshis: Math.max(0, Number(input.minSatoshis || 0)),
        limit: Math.max(0, Math.floor(effectiveLimit)),
        order: ('order' in input && input.order === 'desc') ? 'desc' : 'asc',
        excludeReserved: input.excludeReserved === true,
        confirmedOnly: input.confirmedOnly ?? config.confirmedOnlyDefault,
      },
      countOnly: !('limit' in input),
      includeTotal: true,
    }
  }

  private normaliseLookupResponse(topic: string, payload: any): SpendableOutput[] {
    const defaults = this.getOverlayTopicDefaults(topic)
    return extractLookupItems(payload)
      .map((item: any) => {
        const txid = String(item?.txid || item?.tx_hash || item?.hash || '')
        const vout = Number(item?.vout ?? item?.tx_pos ?? item?.outputIndex ?? 0)
        const satoshis = Number(item?.satoshis ?? item?.value ?? item?.amountSats ?? 0)
        const outputScript = String(
          item?.outputScript ||
          item?.lockingScript ||
          item?.scriptHex ||
          defaults.outputScript ||
          ''
        )
        const confirmed = typeof item?.confirmed === 'boolean'
          ? item.confirmed
          : isLegacyUtxoConfirmed(item)
        return {
          topic,
          walletIndex: defaults.walletIndex,
          address: defaults.address,
          txid,
          vout,
          outputScript,
          satoshis,
          rawTx: typeof item?.rawTx === 'string' ? item.rawTx : null,
          proof: item?.proof ?? item?.beef ?? null,
          confirmed,
          admittedAt: typeof item?.admittedAt === 'string'
            ? item.admittedAt
            : (typeof item?.admitted_at === 'string' ? item.admitted_at : null),
          source: 'overlay' as const,
        }
      })
      .filter(output => output.txid.length > 0 && output.satoshis >= 0)
  }

  async countSpendable(input: CountSpendableInput): Promise<number> {
    const overlay = getOverlayHttpConfig()
    if (!overlay.lookupUrl) {
      throw new Error('Overlay lookup URL not configured')
    }
    const resolvedTopic = resolveTreasuryTopic(input.topic)
    try {
      const payload = await postJsonWithRetry(
        'lookup',
        overlay.lookupUrl,
        overlay.lookupHeaders,
        this.buildLookupBody(input, 1),
        overlay.timeoutMs,
        overlay.maxRetries,
        [resolvedTopic.topic],
      )
      registerOverlayWalletSuccess(resolvedTopic.walletIndex, 'lookup')
      const total = extractLookupTotal(payload)
      if (total != null) return total

      if (overlay.countFallbackLimit <= 0) {
        throw new Error('Overlay lookup count response did not include total/count and fallback is disabled')
      }

      const warnedKey = OVERLAY_COUNT_FALLBACK_WARN_KEY
      const globalState = globalThis as any
      if (!globalState[warnedKey]) {
        globalState[warnedKey] = true
        console.warn('⚠️ Overlay lookup count response did not include total/count; falling back to a bounded list lookup for countSpendable().')
      }
      const outputs = await this.listSpendable({
        ...input,
        limit: overlay.countFallbackLimit,
        order: 'asc',
      })
      return outputs.length
    } catch (error) {
      registerOverlayWalletFailure(
        resolvedTopic.walletIndex,
        'lookup',
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  async listSpendable(input: ListSpendableInput): Promise<SpendableOutput[]> {
    const overlay = getOverlayHttpConfig()
    if (!overlay.lookupUrl) {
      throw new Error('Overlay lookup URL not configured')
    }
    const resolvedTopic = resolveTreasuryTopic(input.topic)
    try {
      const payload = await postJsonWithRetry(
        'lookup',
        overlay.lookupUrl,
        overlay.lookupHeaders,
        this.buildLookupBody(input),
        overlay.timeoutMs,
        overlay.maxRetries,
        [resolvedTopic.topic],
      )
      registerOverlayWalletSuccess(resolvedTopic.walletIndex, 'lookup')
      const outputs = this.normaliseLookupResponse(input.topic, payload)
      const order = input.order === 'desc' ? 'desc' : 'asc'
      const limit = Math.max(0, Math.floor(Number.isFinite(input.limit) ? input.limit : DEFAULT_LIST_LIMIT))
      return outputs
        .sort((left, right) => {
          const direction = order === 'desc' ? -1 : 1
          if (left.satoshis !== right.satoshis) return direction * (left.satoshis - right.satoshis)
          const txidCmp = left.txid.localeCompare(right.txid)
          if (txidCmp !== 0) return direction * txidCmp
          return direction * (left.vout - right.vout)
        })
        .slice(0, limit)
    } catch (error) {
      registerOverlayWalletFailure(
        resolvedTopic.walletIndex,
        'lookup',
        error instanceof Error ? error.message : String(error),
      )
      throw error
    }
  }

  async submitAcceptedTx(input: SubmitAcceptedTxInput): Promise<SubmitAcceptedTxResult> {
    const overlay = getOverlayHttpConfig()
    const spendSourceConfig = getSpendSourceConfig()
    if (!overlay.submitUrl) {
      throw new Error('Overlay submit URL not configured')
    }
    const resolvedTopics = input.topics.map(topic => resolveTreasuryTopic(topic))
    const envelope = parseSubmitEnvelope(input.rawTxEnvelope)

    try {
      const payload = await postJsonWithRetry(
        'submit',
        overlay.submitUrl,
        overlay.submitHeaders,
        {
          clientRequestId: input.clientRequestId,
          topics: input.topics,
          txid: envelope.txid,
          rawTx: envelope.rawTx,
          prevouts: envelope.prevouts,
          mapiResponses: envelope.mapiResponses,
          beef: envelope.beef,
          proof: envelope.proof,
        },
        overlay.timeoutMs,
        overlay.maxRetries,
        resolvedTopics.map(topic => topic.topic),
      )
      const ackSummary = normaliseAckSummary(payload)
      const allHostsAcknowledged = typeof payload?.allHostsAcknowledged === 'boolean'
        ? payload.allHostsAcknowledged
        : (Object.keys(ackSummary).length > 0 && Object.values(ackSummary).every(status => status === 'ack'))
      const requireAllHostAcks = input.requireAllHostAcks ?? spendSourceConfig.overlayRequireAllHostAcks
      const accepted = typeof payload?.accepted === 'boolean'
        ? (requireAllHostAcks ? (payload.accepted && allHostsAcknowledged) : payload.accepted)
        : (requireAllHostAcks ? allHostsAcknowledged : (allHostsAcknowledged || Object.values(ackSummary).some(status => status === 'ack')))

      if (accepted) {
        for (const topic of resolvedTopics) {
          registerOverlayWalletSuccess(topic.walletIndex, 'submit')
        }
      } else {
        for (const topic of resolvedTopics) {
          registerOverlayWalletFailure(
            topic.walletIndex,
            'submit',
            `Overlay submit was not accepted for ${topic.topic} (allHostsAcknowledged=${allHostsAcknowledged})`,
          )
        }
      }

      return {
        clientRequestId: input.clientRequestId,
        ackSummary,
        allHostsAcknowledged,
        accepted,
      }
    } catch (error) {
      for (const topic of resolvedTopics) {
        registerOverlayWalletFailure(
          topic.walletIndex,
          'submit',
          error instanceof Error ? error.message : String(error),
        )
      }
      throw error
    }
  }
}

class ShadowSpendSource implements SpendSource {
  constructor(
    private readonly primary: SpendSource,
    private readonly shadow: SpendSource,
    private readonly label: string,
  ) {}

  async countSpendable(input: CountSpendableInput): Promise<number> {
    const primaryCount = await this.primary.countSpendable(input)
    void this.compareCount(input, primaryCount)
    return primaryCount
  }

  async listSpendable(input: ListSpendableInput): Promise<SpendableOutput[]> {
    const primaryOutputs = await this.primary.listSpendable(input)
    void this.compareList(input, primaryOutputs)
    return primaryOutputs
  }

  async submitAcceptedTx(input: SubmitAcceptedTxInput): Promise<SubmitAcceptedTxResult> {
    return this.primary.submitAcceptedTx(input)
  }

  private async compareCount(input: CountSpendableInput, primaryCount: number): Promise<void> {
    try {
      const shadowCount = await this.shadow.countSpendable(input)
      const exactMatch = primaryCount === shadowCount
      const reason = exactMatch ? null : `${this.label}: primary=${primaryCount} shadow=${shadowCount}`
      spendSourceObservability.recordShadowComparison('count', input.topic, exactMatch, reason)
      if (!exactMatch && shouldLogShadowDrift(input.topic)) {
        console.warn(`⚠️ Spend-source count drift for ${input.topic}: ${reason}`)
      }
    } catch (error) {
      const reason = `${this.label}: shadow count failed (${error instanceof Error ? error.message : String(error)})`
      spendSourceObservability.recordShadowComparison('count', input.topic, false, reason)
      if (shouldLogShadowDrift(input.topic)) {
        console.warn(`⚠️ Spend-source shadow count failed for ${input.topic}: ${reason}`)
      }
    }
  }

  private async compareList(input: ListSpendableInput, primaryOutputs: SpendableOutput[]): Promise<void> {
    try {
      const shadowOutputs = await this.shadow.listSpendable(input)
      const primaryKeys = new Set(primaryOutputs.map(outpointKey))
      const shadowKeys = new Set(shadowOutputs.map(outpointKey))
      const intersection = Array.from(primaryKeys).filter(key => shadowKeys.has(key))
      const maxSize = Math.max(primaryKeys.size, shadowKeys.size, 1)
      const overlapRatio = intersection.length / maxSize
      const mismatchKeys = [
        ...Array.from(primaryKeys).filter(key => !shadowKeys.has(key)).map(key => `primary:${key}`),
        ...Array.from(shadowKeys).filter(key => !primaryKeys.has(key)).map(key => `shadow:${key}`),
      ].slice(0, 8)
      const exactMatch = primaryKeys.size === shadowKeys.size && overlapRatio === 1
      const reason = exactMatch
        ? null
        : `${this.label}: overlap=${(overlapRatio * 100).toFixed(2)}% primary=${primaryOutputs.length} shadow=${shadowOutputs.length}${mismatchKeys.length > 0 ? ` mismatches=${mismatchKeys.join(',')}` : ''}`
      spendSourceObservability.recordShadowComparison('list', input.topic, exactMatch, reason)
      if (!exactMatch && shouldLogShadowDrift(input.topic)) {
        console.warn(`⚠️ Spend-source list drift for ${input.topic}: ${reason}`)
      }
    } catch (error) {
      const reason = `${this.label}: shadow list failed (${error instanceof Error ? error.message : String(error)})`
      spendSourceObservability.recordShadowComparison('list', input.topic, false, reason)
      if (shouldLogShadowDrift(input.topic)) {
        console.warn(`⚠️ Spend-source shadow list failed for ${input.topic}: ${reason}`)
      }
    }
  }
}

const legacySpendSource = new LegacySpendSource()
const overlaySpendSource = new OverlayHttpSpendSource()

function warnOverlayFallback(reason: string): void {
  const globalState = globalThis as any
  if (globalState[OVERLAY_FALLBACK_WARN_KEY]) return
  globalState[OVERLAY_FALLBACK_WARN_KEY] = true
  console.warn(`⚠️ Overlay spend source unavailable; falling back to legacy selection. ${reason}`)
}

function isOverlayConfigured(config: SpendSourceConfig): boolean {
  return config.overlayLookupConfigured && config.overlaySubmitConfigured
}

function walletUsesOverlay(config: SpendSourceConfig, walletIndex?: number): boolean {
  if (config.mode !== 'overlay') return false
  if (typeof walletIndex === 'number') {
    if (isWalletForcedLegacy(walletIndex) || isWalletTemporarilyFallback(walletIndex)) {
      return false
    }
  }
  if (walletIndex == null || config.canaryWalletIndex == null) return true
  return walletIndex === config.canaryWalletIndex
}

export function getSpendSourceForWallet(walletIndex?: number): SpendSource {
  const config = getSpendSourceConfig()
  const overlayConfigured = isOverlayConfigured(config)

  if (config.mode === 'legacy') {
    return legacySpendSource
  }

  if (config.mode === 'shadow') {
    return overlayConfigured
      ? new ShadowSpendSource(legacySpendSource, overlaySpendSource, 'shadow')
      : legacySpendSource
  }

  if (walletUsesOverlay(config, walletIndex)) {
    if (overlayConfigured) {
      return config.shadowReadsEnabled
        ? new ShadowSpendSource(overlaySpendSource, legacySpendSource, 'overlay')
        : overlaySpendSource
    }
    if (config.legacyFallbackEnabled) {
      warnOverlayFallback('Overlay mode was requested but lookup/submit endpoints are not fully configured.')
      return legacySpendSource
    }
    throw new Error('Overlay spend source requested but lookup/submit endpoints are not fully configured')
  }

  if (config.shadowReadsEnabled && overlayConfigured) {
    return new ShadowSpendSource(legacySpendSource, overlaySpendSource, 'overlay-canary')
  }
  return legacySpendSource
}

export function getSpendSource(): SpendSource {
  return getSpendSourceForWallet()
}
