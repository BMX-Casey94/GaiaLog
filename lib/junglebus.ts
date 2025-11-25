/**
 * GaiaLog Transaction Indexer (WhatsonChain-based)
 * 
 * Since JungleBus requires WebSocket client and the npm package has issues,
 * this uses WhatsonChain's address history API to fetch GaiaLog transactions.
 * 
 * This is simpler and more reliable for our use case.
 * Data is stored in a JSON file - no PostgreSQL required!
 */

import { APP_NAME } from './constants'
import {
  addReadingsBatch,
  saveCursor,
  loadCursor,
  loadIndex,
  type StoredReading,
  type JunglebusCursor,
} from './explorer-store'

// Configuration
const START_BLOCK = parseInt(process.env.JUNGLEBUS_START_BLOCK || '0', 10)
const BATCH_SIZE = parseInt(process.env.JUNGLEBUS_BATCH_SIZE || '20', 10)

// WhatsonChain API (no rate limiting on testnet, 3 RPS on mainnet)
const WOC_API = process.env.BSV_NETWORK === 'mainnet' 
  ? 'https://api.whatsonchain.com/v1/bsv/main'
  : 'https://api.whatsonchain.com/v1/bsv/test'

// GaiaLog wallet addresses to scan
const WALLET_ADDRESSES = [
  process.env.BSV_WALLET_1_ADDRESS,
  process.env.BSV_WALLET_2_ADDRESS,
  process.env.BSV_WALLET_3_ADDRESS,
].filter(Boolean) as string[]

// If no addresses configured, try to derive from private keys
// (For now, we'll require explicit addresses in env)

// Types
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

/**
 * Rate limiter for WhatsonChain API
 */
class RateLimiter {
  private lastCall = 0
  private minInterval: number
  
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

const rateLimiter = new RateLimiter(2) // 2 calls per second to be safe

/**
 * Fetch address transaction history from WhatsonChain
 */
async function fetchAddressHistory(address: string): Promise<WocTxHistory[]> {
  await rateLimiter.wait()
  
  try {
    const response = await fetch(`${WOC_API}/address/${address}/history`)
    if (!response.ok) {
      throw new Error(`WoC API error: ${response.status}`)
    }
    return await response.json()
  } catch (error) {
    console.error(`Failed to fetch history for ${address}:`, error)
    return []
  }
}

/**
 * Fetch transaction details from WhatsonChain
 */
async function fetchTxDetails(txid: string): Promise<WocTxDetails | null> {
  await rateLimiter.wait()
  
  try {
    const response = await fetch(`${WOC_API}/tx/${txid}`)
    if (!response.ok) {
      return null
    }
    return await response.json()
  } catch (error) {
    console.error(`Failed to fetch tx ${txid}:`, error)
    return null
  }
}

/**
 * Decode GaiaLog OP_RETURN from transaction output
 */
function decodeGaiaLogFromTx(tx: WocTxDetails): DecodedGaiaLogTx | null {
  try {
    // Find OP_RETURN output
    const opReturnOut = tx.vout.find(out => 
      out.scriptPubKey.type === 'nulldata' || 
      out.scriptPubKey.asm.startsWith('OP_FALSE OP_RETURN') ||
      out.scriptPubKey.asm.startsWith('0 OP_RETURN')
    )
    
    if (!opReturnOut) {
      return null
    }
    
    // Decode the script hex
    const scriptHex = opReturnOut.scriptPubKey.hex
    
    // Look for GaiaLog marker
    const gaiaLogHex = Buffer.from('GaiaLog').toString('hex')
    const markerIndex = scriptHex.indexOf(gaiaLogHex)
    
    if (markerIndex < 0) {
      return null
    }
    
    // Find JSON payload after marker
    const searchStart = markerIndex + gaiaLogHex.length
    const jsonStartHex = '7b' // {
    const jsonStart = scriptHex.indexOf(jsonStartHex, searchStart)
    
    if (jsonStart < 0) {
      return null
    }
    
    // Decode JSON from hex
    let hexPayload = scriptHex.substring(jsonStart)
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
    
    if (!decoded || braceCount !== 0) {
      return null
    }
    
    // Parse JSON
    const opReturnData = JSON.parse(decoded)
    const payload = opReturnData.payload || opReturnData
    const dataType = opReturnData.data_type || payload.data_type || 'unknown'
    
    // Extract location
    let location: string | null = null
    let lat: number | null = null
    let lon: number | null = null
    
    if (payload.location) {
      location = payload.location
    } else if (payload.location_ascii) {
      location = payload.location_ascii
    } else if (payload.station_name) {
      location = payload.station_name
    } else if (payload.city) {
      location = payload.city
    }
    
    if (payload.coordinates) {
      lat = payload.coordinates.lat ?? payload.coordinates.latitude ?? null
      lon = payload.coordinates.lon ?? payload.coordinates.longitude ?? null
    } else if (payload.latitude !== undefined && payload.longitude !== undefined) {
      lat = payload.latitude
      lon = payload.longitude
    }
    
    // Extract timestamp
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
      dataType: normalizeDataType(dataType),
      location,
      lat,
      lon,
      timestamp,
      metrics: payload,
      provider: opReturnData.provider || payload.provider || null,
    }
    
  } catch (error) {
    return null
  }
}

/**
 * Normalise data type string
 */
function normalizeDataType(dataType: string): string {
  const normalized = dataType.toLowerCase().replace(/[^a-z_]/g, '_')
  
  const typeMap: Record<string, string> = {
    'air_quality': 'air_quality',
    'airquality': 'air_quality',
    'water_levels': 'water_levels',
    'waterlevels': 'water_levels',
    'water_level': 'water_levels',
    'seismic_activity': 'seismic_activity',
    'seismicactivity': 'seismic_activity',
    'seismic': 'seismic_activity',
    'advanced_metrics': 'advanced_metrics',
    'advancedmetrics': 'advanced_metrics',
    'advanced': 'advanced_metrics',
  }
  
  return typeMap[normalized] || normalized
}

/**
 * Transaction Indexer Worker
 * 
 * Scans wallet addresses via WhatsonChain and indexes GaiaLog transactions.
 */
export class JungleBusWorker {
  private isRunning = false
  private shouldStop = false
  private addresses: string[]
  private processedTx = 0
  private newTx = 0
  
  constructor(addresses?: string[]) {
    this.addresses = addresses || WALLET_ADDRESSES
    
    if (this.addresses.length === 0) {
      console.warn('⚠️ No wallet addresses configured')
      console.warn('   Add BSV_WALLET_1_ADDRESS, BSV_WALLET_2_ADDRESS, BSV_WALLET_3_ADDRESS to .env.local')
    }
  }
  
  /**
   * Start indexing from WhatsonChain
   */
  async start(): Promise<void> {
    if (this.addresses.length === 0) {
      throw new Error('No wallet addresses configured. Add BSV_WALLET_*_ADDRESS to .env.local')
    }
    
    if (this.isRunning) {
      console.warn('Indexer already running')
      return
    }
    
    this.isRunning = true
    this.shouldStop = false
    this.processedTx = 0
    this.newTx = 0
    
    console.log(`🚀 Starting GaiaLog transaction indexer`)
    console.log(`📍 Network: ${process.env.BSV_NETWORK || 'testnet'}`)
    console.log(`📫 Addresses to scan: ${this.addresses.length}`)
    
    // Get existing txids to avoid duplicates
    const existingIndex = loadIndex()
    const existingTxids = new Set(existingIndex.readings.map(r => r.txid))
    console.log(`📊 Existing readings: ${existingTxids.size}`)
    
    // Scan each address
    for (const address of this.addresses) {
      if (this.shouldStop) break
      
      console.log(`\n🔍 Scanning address: ${address.substring(0, 8)}...${address.slice(-6)}`)
      
      try {
        // Fetch transaction history
        const history = await fetchAddressHistory(address)
        console.log(`   Found ${history.length} transactions`)
        
        // Filter to only process new transactions
        const newTxs = history.filter(tx => !existingTxids.has(tx.tx_hash))
        console.log(`   New transactions: ${newTxs.length}`)
        
        // Process in batches
        const readings: StoredReading[] = []
        
        for (let i = 0; i < newTxs.length && !this.shouldStop; i++) {
          const txRef = newTxs[i]
          this.processedTx++
          
          // Fetch full transaction details
          const txDetails = await fetchTxDetails(txRef.tx_hash)
          if (!txDetails) continue
          
          // Try to decode as GaiaLog
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
            console.log(`   ✅ ${decoded.txid.substring(0, 8)}... | ${decoded.dataType} | ${locationStr}`)
          }
          
          // Save in batches
          if (readings.length >= BATCH_SIZE) {
            addReadingsBatch(readings)
            readings.length = 0
          }
          
          // Progress update
          if (this.processedTx % 50 === 0) {
            console.log(`   📦 Processed ${this.processedTx} transactions, found ${this.newTx} GaiaLog readings`)
          }
        }
        
        // Save remaining readings
        if (readings.length > 0) {
          addReadingsBatch(readings)
        }
        
      } catch (error) {
        console.error(`   ❌ Error scanning address:`, error)
      }
    }
    
    // Update cursor
    const cursorData: JunglebusCursor = {
      subscriptionId: 'woc-indexer',
      lastBlock: 0,
      processedCount: loadIndex().processedCount,
      updatedAt: Date.now(),
    }
    saveCursor(cursorData)
    
    if (!this.shouldStop) {
      console.log(`\n✅ Indexing complete!`)
      console.log(`   Processed: ${this.processedTx} transactions`)
      console.log(`   New GaiaLog readings: ${this.newTx}`)
    }
    
    this.isRunning = false
  }
  
  /**
   * Stop the indexer
   */
  async stop(): Promise<void> {
    console.log('🛑 Stopping indexer...')
    this.shouldStop = true
    
    while (this.isRunning) {
      await sleep(100)
    }
    
    console.log(`✅ Indexer stopped. Processed ${this.processedTx} transactions, found ${this.newTx} GaiaLog readings.`)
  }
  
  /**
   * Get worker status
   */
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

// Helper
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Singleton
let workerInstance: JungleBusWorker | null = null

export function getJungleBusWorker(): JungleBusWorker {
  if (!workerInstance) {
    workerInstance = new JungleBusWorker()
  }
  return workerInstance
}

export async function startJungleBusWorker(): Promise<void> {
  const worker = getJungleBusWorker()
  await worker.start()
}

export async function stopJungleBusWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.stop()
  }
}
