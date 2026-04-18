/**
 * GaiaLog Explorer Sync (WhatsonChain-based)
 *
 * Scans configured wallet addresses via WhatsonChain history endpoints and
 * writes decoded GaiaLog readings through the configured explorer write path.
 */

import {
  addReadingsBatch,
  type StoredReading,
} from './explorer-read-source'
import { normaliseDataFamily } from './stream-registry'

const START_BLOCK = parseInt(process.env.EXPLORER_SYNC_START_BLOCK || '0', 10)
const BATCH_SIZE = parseInt(process.env.EXPLORER_SYNC_BATCH_SIZE || '20', 10)

const WOC_API = process.env.BSV_NETWORK === 'mainnet'
  ? 'https://api.whatsonchain.com/v1/bsv/main'
  : 'https://api.whatsonchain.com/v1/bsv/test'

const WALLET_ADDRESSES = [
  process.env.BSV_WALLET_1_ADDRESS,
  process.env.BSV_WALLET_2_ADDRESS,
  process.env.BSV_WALLET_3_ADDRESS,
].filter(Boolean) as string[]

export interface DecodedGaiaLogTx {
  txid: string
  blockHeight: number
  blockTime: number | null
  dataType: string
  location: string | null
  lat: number | null
  lon: number | null
  timestamp: number
  metrics: Record<string, any>
  provider: string | null
}

interface WocTxHistory {
  tx_hash: string
  height: number
}

interface WocTxDetails {
  txid: string
  hash: string
  blockheight: number
  blocktime: number
  vout: Array<{
    value: number
    n: number
    scriptPubKey: {
      asm: string
      hex: string
      type: string
    }
  }>
}

class RateLimiter {
  private lastCall = 0
  private readonly minInterval: number

  constructor(callsPerSecond: number) {
    this.minInterval = 1000 / callsPerSecond
  }

  async wait(): Promise<void> {
    const now = Date.now()
    const elapsed = now - this.lastCall
    if (elapsed < this.minInterval) {
      await sleep(this.minInterval - elapsed)
    }
    this.lastCall = Date.now()
  }
}

const rateLimiter = new RateLimiter(2)

async function fetchAddressHistory(address: string): Promise<WocTxHistory[]> {
  await rateLimiter.wait()

  try {
    const response = await fetch(`${WOC_API}/address/${address}/history`)
    if (!response.ok) {
      throw new Error(`WoC API error: ${response.status}`)
    }

    const history = await response.json() as WocTxHistory[]
    if (!START_BLOCK || START_BLOCK <= 0) return history
    return history.filter(tx => Number(tx.height || 0) >= START_BLOCK)
  } catch (error) {
    console.error(`Failed to fetch history for ${address}:`, error)
    return []
  }
}

async function fetchTxDetails(txid: string): Promise<WocTxDetails | null> {
  await rateLimiter.wait()

  try {
    const response = await fetch(`${WOC_API}/tx/${txid}`)
    if (!response.ok) {
      return null
    }
    return await response.json() as WocTxDetails
  } catch (error) {
    console.error(`Failed to fetch tx ${txid}:`, error)
    return null
  }
}

function decodeGaiaLogFromTx(tx: WocTxDetails): DecodedGaiaLogTx | null {
  try {
    const opReturnOut = tx.vout.find(out =>
      out.scriptPubKey.type === 'nulldata' ||
      out.scriptPubKey.asm.startsWith('OP_FALSE OP_RETURN') ||
      out.scriptPubKey.asm.startsWith('0 OP_RETURN'),
    )

    if (!opReturnOut) return null

    const scriptHex = opReturnOut.scriptPubKey.hex
    const gaiaLogHex = Buffer.from('GaiaLog').toString('hex')
    const markerIndex = scriptHex.indexOf(gaiaLogHex)
    if (markerIndex < 0) return null

    const searchStart = markerIndex + gaiaLogHex.length
    const jsonStart = scriptHex.indexOf('7b', searchStart)
    if (jsonStart < 0) return null

    const hexPayload = scriptHex.substring(jsonStart)
    let decoded = ''
    let braceCount = 0
    let started = false

    for (let i = 0; i < hexPayload.length; i += 2) {
      const byte = parseInt(hexPayload.substring(i, i + 2), 16)
      if (isNaN(byte) || byte === 0) break

      const char = String.fromCharCode(byte)
      if (char === '{') {
        started = true
        braceCount++
      }

      if (started) {
        decoded += char
        if (char === '}') {
          braceCount--
          if (braceCount === 0) break
        }
      }
    }

    if (!decoded || braceCount !== 0) return null

    const opReturnData = JSON.parse(decoded)
    const payload = opReturnData.payload || opReturnData
    const dataType = opReturnData.data_type || payload.data_type || 'unknown'

    let location: string | null = null
    let lat: number | null = null
    let lon: number | null = null

    if (payload.location) location = payload.location
    else if (payload.location_ascii) location = payload.location_ascii
    else if (payload.station_name) location = payload.station_name
    else if (payload.city) location = payload.city

    if (payload.coordinates) {
      lat = payload.coordinates.lat ?? payload.coordinates.latitude ?? null
      lon = payload.coordinates.lon ?? payload.coordinates.longitude ?? null
    } else if (payload.latitude !== undefined && payload.longitude !== undefined) {
      lat = payload.latitude
      lon = payload.longitude
    }

    let timestamp = tx.blocktime ? tx.blocktime * 1000 : Date.now()
    if (opReturnData.timestamp) {
      timestamp = typeof opReturnData.timestamp === 'number'
        ? opReturnData.timestamp
        : new Date(opReturnData.timestamp).getTime()
    } else if (payload.timestamp) {
      timestamp = typeof payload.timestamp === 'number'
        ? payload.timestamp
        : new Date(payload.timestamp).getTime()
    }

    return {
      txid: tx.txid,
      blockHeight: tx.blockheight || 0,
      blockTime: tx.blocktime ? tx.blocktime * 1000 : null,
      dataType: normaliseDataType(dataType),
      location,
      lat,
      lon,
      timestamp,
      metrics: payload,
      provider: opReturnData.provider || payload.provider || null,
    }
  } catch {
    return null
  }
}

function normaliseDataType(dataType: string): string {
  const normalized = dataType.toLowerCase().replace(/[^a-z_]/g, '_')
  return normaliseDataFamily(normalized) || normalized
}

export class ExplorerSyncWorker {
  private isRunning = false
  private shouldStop = false
  private readonly addresses: string[]
  private processedTx = 0
  private newTx = 0

  constructor(addresses?: string[]) {
    this.addresses = addresses || WALLET_ADDRESSES

    if (this.addresses.length === 0) {
      console.warn('No wallet addresses configured')
      console.warn('Add BSV_WALLET_1_ADDRESS, BSV_WALLET_2_ADDRESS, BSV_WALLET_3_ADDRESS to your environment')
    }
  }

  async start(): Promise<void> {
    if (this.addresses.length === 0) {
      throw new Error('No wallet addresses configured. Add BSV_WALLET_*_ADDRESS to your environment')
    }

    if (this.isRunning) {
      console.warn('Explorer sync is already running')
      return
    }

    this.isRunning = true
    this.shouldStop = false
    this.processedTx = 0
    this.newTx = 0

    console.log('Starting GaiaLog explorer sync')
    console.log(`Network: ${process.env.BSV_NETWORK || 'testnet'}`)
    console.log(`Addresses to scan: ${this.addresses.length}`)
    if (START_BLOCK > 0) {
      console.log(`Start block filter: ${START_BLOCK}`)
    }

    const existingTxids = new Set<string>()
    console.log('Explorer write path handles deduplication; scanning configured addresses')

    for (const address of this.addresses) {
      if (this.shouldStop) break

      console.log(`\nScanning address: ${address.substring(0, 8)}...${address.slice(-6)}`)

      try {
        const history = await fetchAddressHistory(address)
        console.log(`Found ${history.length} transactions after filtering`)

        const newTxs = history.filter(tx => !existingTxids.has(tx.tx_hash))
        console.log(`Candidate transactions: ${newTxs.length}`)

        const readings: StoredReading[] = []

        for (let i = 0; i < newTxs.length && !this.shouldStop; i++) {
          const txRef = newTxs[i]
          this.processedTx++

          const txDetails = await fetchTxDetails(txRef.tx_hash)
          if (!txDetails) continue

          const decoded = decodeGaiaLogFromTx(txDetails)
          if (decoded) {
            readings.push({
              txid: decoded.txid,
              dataType: decoded.dataType,
              location: decoded.location,
              lat: decoded.lat,
              lon: decoded.lon,
              timestamp: decoded.timestamp,
              metrics: decoded.metrics,
              provider: decoded.provider,
              blockHeight: decoded.blockHeight,
              blockTime: decoded.blockTime,
            })
            existingTxids.add(decoded.txid)
            this.newTx++

            const locationStr = decoded.location || 'Unknown'
            console.log(`   ${decoded.txid.substring(0, 8)}... | ${decoded.dataType} | ${locationStr}`)
          }

          if (readings.length >= BATCH_SIZE) {
            await addReadingsBatch(readings)
            readings.length = 0
          }

          if (this.processedTx % 50 === 0) {
            console.log(`Processed ${this.processedTx} transactions, found ${this.newTx} GaiaLog readings`)
          }
        }

        if (readings.length > 0) {
          await addReadingsBatch(readings)
        }
      } catch (error) {
        console.error('Error scanning address:', error)
      }
    }

    if (!this.shouldStop) {
      console.log('\nExplorer sync complete')
      console.log(`Processed: ${this.processedTx} transactions`)
      console.log(`New GaiaLog readings: ${this.newTx}`)
    }

    this.isRunning = false
  }

  async stop(): Promise<void> {
    console.log('Stopping explorer sync...')
    this.shouldStop = true

    while (this.isRunning) {
      await sleep(100)
    }

    console.log(`Explorer sync stopped. Processed ${this.processedTx} transactions, found ${this.newTx} GaiaLog readings.`)
  }

  getStatus(): {
    isRunning: boolean
    addresses: string[]
    processedTx: number
    newTx: number
  } {
    return {
      isRunning: this.isRunning,
      addresses: this.addresses,
      processedTx: this.processedTx,
      newTx: this.newTx,
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
