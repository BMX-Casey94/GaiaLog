#!/usr/bin/env npx tsx
/**
 * GaiaLog Explorer Backfill via JungleBus WebSocket
 *
 * Uses the official @gorillapool/js-junglebus client to replay ALL
 * historical transactions from the configured start block into the
 * Supabase explorer_readings table.
 *
 * Features:
 *  - Automatic resume from the last block_height stored in Supabase
 *  - Batch upserts (500 rows per Supabase call)
 *  - Real-time progress logging
 *  - Graceful shutdown on Ctrl+C
 *  - JungleBus auto-reconnect built in
 *
 * Usage:
 *   npm run explorer:backfill
 *   npx tsx scripts/backfill-explorer.ts
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.join(process.cwd(), '.env.local') })
dotenv.config({ path: path.join(process.cwd(), '.env') })

import { JungleBusClient, ControlMessageStatusCode } from '@gorillapool/js-junglebus'
import { addReadingsBatch, getIndexStats, type StoredReading } from '../lib/supabase-explorer'

// ── Configuration ────────────────────────────────────────────────────────────

const JUNGLEBUS_SUB_ID = process.env.JUNGLEBUS_SUBSCRIPTION_ID
const START_BLOCK = parseInt(process.env.JUNGLEBUS_START_BLOCK || '720000', 10)
const JUNGLEBUS_SERVER = 'junglebus.gorillapool.io'
const BATCH_SIZE = 500
const FLUSH_INTERVAL_MS = 15_000 // flush every 15s even if batch not full

// ── State ────────────────────────────────────────────────────────────────────

let totalProcessed = 0
let totalGaiaLog = 0
let currentBlock = 0
let shouldStop = false
let pendingBatch: StoredReading[] = []
let lastFlushTime = Date.now()
let flushTimer: ReturnType<typeof setInterval> | null = null

// ── Raw Bitcoin Transaction Parser ───────────────────────────────────────────

function readVarint(hex: string, offset: number): { value: number; size: number } {
  const firstByte = parseInt(hex.substring(offset, offset + 2), 16)
  if (firstByte < 0xfd) {
    return { value: firstByte, size: 2 }
  } else if (firstByte === 0xfd) {
    const lo = parseInt(hex.substring(offset + 2, offset + 4), 16)
    const hi = parseInt(hex.substring(offset + 4, offset + 6), 16)
    return { value: lo + hi * 256, size: 6 }
  } else if (firstByte === 0xfe) {
    let val = 0
    for (let i = 0; i < 4; i++) {
      val += parseInt(hex.substring(offset + 2 + i * 2, offset + 4 + i * 2), 16) * (256 ** i)
    }
    return { value: val, size: 10 }
  } else {
    let val = 0
    for (let i = 0; i < 8; i++) {
      val += parseInt(hex.substring(offset + 2 + i * 2, offset + 4 + i * 2), 16) * (256 ** i)
    }
    return { value: val, size: 18 }
  }
}

function parseRawTxOutputs(hex: string): Array<{ value: number; scriptHex: string }> {
  let pos = 0
  pos += 8 // version (4 bytes)

  const inCount = readVarint(hex, pos)
  pos += inCount.size

  for (let i = 0; i < inCount.value; i++) {
    pos += 64 // prev tx hash (32 bytes)
    pos += 8  // prev output index (4 bytes)
    const scriptLen = readVarint(hex, pos)
    pos += scriptLen.size
    pos += scriptLen.value * 2
    pos += 8 // sequence (4 bytes)
  }

  const outCount = readVarint(hex, pos)
  pos += outCount.size

  const outputs: Array<{ value: number; scriptHex: string }> = []

  for (let i = 0; i < outCount.value; i++) {
    let value = 0
    for (let b = 0; b < 8; b++) {
      value += parseInt(hex.substring(pos + b * 2, pos + b * 2 + 2), 16) * (256 ** b)
    }
    pos += 16

    const sLen = readVarint(hex, pos)
    pos += sLen.size

    const scriptHex = hex.substring(pos, pos + sLen.value * 2)
    pos += sLen.value * 2

    outputs.push({ value, scriptHex })
  }

  return outputs
}

// ── GaiaLog OP_RETURN Decoder ────────────────────────────────────────────────

const GAIALOG_HEX = Buffer.from('GaiaLog').toString('hex')

function decodeGaiaLogFromOutputs(
  outputs: Array<{ value: number; scriptHex: string }>,
  txid: string,
  blockHeight: number,
  blockTime: number
): StoredReading | null {
  for (const out of outputs) {
    const script = out.scriptHex

    // OP_FALSE OP_RETURN (006a) or OP_RETURN (6a)
    const isOpReturn = script.startsWith('006a') || script.startsWith('6a')
    if (!isOpReturn) continue

    const markerIdx = script.indexOf(GAIALOG_HEX)
    if (markerIdx < 0) continue

    const searchStart = markerIdx + GAIALOG_HEX.length
    const jsonStart = script.indexOf('7b', searchStart) // 0x7b = '{'
    if (jsonStart < 0) continue

    const hexPayload = script.substring(jsonStart)
    let decoded = ''
    let braceCount = 0
    let started = false

    for (let i = 0; i < hexPayload.length; i += 2) {
      const byte = parseInt(hexPayload.substring(i, i + 2), 16)
      if (isNaN(byte) || byte === 0) break
      const char = String.fromCharCode(byte)
      if (char === '{') { started = true; braceCount++ }
      if (started) {
        decoded += char
        if (char === '}') { braceCount--; if (braceCount === 0) break }
      }
    }

    if (!decoded || braceCount !== 0) continue

    try {
      const opReturnData = JSON.parse(decoded)
      const payload = opReturnData.payload || opReturnData
      const dataType = normalizeDataType(
        opReturnData.data_type || payload.data_type || 'unknown'
      )

      let location: string | null = null
      if (payload.location) location = payload.location
      else if (payload.location_ascii) location = payload.location_ascii
      else if (payload.station_name) location = payload.station_name
      else if (payload.city) location = payload.city

      let lat: number | null = null
      let lon: number | null = null
      if (payload.coordinates) {
        lat = payload.coordinates.lat ?? payload.coordinates.latitude ?? null
        lon = payload.coordinates.lon ?? payload.coordinates.longitude ?? null
      } else if (payload.latitude !== undefined && payload.longitude !== undefined) {
        lat = payload.latitude
        lon = payload.longitude
      }

      let timestamp = blockTime ? blockTime * 1000 : Date.now()
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
        txid,
        dataType,
        location,
        lat,
        lon,
        timestamp,
        metrics: payload,
        provider: opReturnData.provider || payload.provider || null,
        blockHeight,
        blockTime: blockTime ? blockTime * 1000 : null,
      }
    } catch {
      // Invalid JSON – skip
    }
  }

  return null
}

function normalizeDataType(dt: string): string {
  const n = dt.toLowerCase().replace(/[^a-z_]/g, '_')
  const map: Record<string, string> = {
    air_quality: 'air_quality',
    airquality: 'air_quality',
    water_levels: 'water_levels',
    waterlevels: 'water_levels',
    water_level: 'water_levels',
    seismic_activity: 'seismic_activity',
    seismicactivity: 'seismic_activity',
    seismic: 'seismic_activity',
    advanced_metrics: 'advanced_metrics',
    advancedmetrics: 'advanced_metrics',
    advanced: 'advanced_metrics',
  }
  return map[n] || n
}

// ── Batch Flushing ───────────────────────────────────────────────────────────

async function flushBatch(): Promise<void> {
  if (pendingBatch.length === 0) return

  const batch = [...pendingBatch]
  pendingBatch = []

  try {
    const inserted = await addReadingsBatch(batch)
    totalGaiaLog += inserted
    lastFlushTime = Date.now()
  } catch (err) {
    console.error('\n   Batch insert failed:', err)
    pendingBatch.unshift(...batch)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log()
  console.log('============================================================')
  console.log('  GaiaLog Explorer Backfill (JungleBus WS -> Supabase)')
  console.log('============================================================')
  console.log()

  if (!JUNGLEBUS_SUB_ID) {
    console.error('Error: JUNGLEBUS_SUBSCRIPTION_ID not set')
    process.exit(1)
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Error: Supabase credentials not configured')
    process.exit(1)
  }

  console.log(`   Network:      ${process.env.BSV_NETWORK || 'testnet'}`)
  console.log(`   JungleBus:    ${JUNGLEBUS_SUB_ID.substring(0, 16)}...`)
  console.log(`   Supabase:     ${process.env.NEXT_PUBLIC_SUPABASE_URL}`)

  // Get resume point from Supabase
  let fromBlock = START_BLOCK
  try {
    const stats = await getIndexStats()
    if (stats.lastBlock > 0) {
      fromBlock = stats.lastBlock + 1
      console.log(`   Existing:     ${stats.totalReadings.toLocaleString()} readings`)
      console.log(`   Resuming:     block ${fromBlock.toLocaleString()}`)
    } else {
      console.log(`   Starting:     block ${START_BLOCK.toLocaleString()} (fresh)`)
    }
  } catch {
    console.log(`   Starting:     block ${START_BLOCK.toLocaleString()} (fresh)`)
  }

  console.log()
  console.log('   Connecting to JungleBus WebSocket...')
  console.log()

  // Periodic flush timer
  flushTimer = setInterval(async () => {
    if (pendingBatch.length > 0) {
      await flushBatch()
    }
  }, FLUSH_INTERVAL_MS)

  // Create JungleBus client
  const client = new JungleBusClient(JUNGLEBUS_SERVER, {
    useSSL: true,
    onConnected(ctx) {
      console.log('   Connected to JungleBus WebSocket')
    },
    onConnecting(ctx) {
      console.log('   Connecting to JungleBus...')
    },
    onDisconnected(ctx) {
      console.log('\n   Disconnected from JungleBus')
    },
    onError(ctx) {
      console.error('\n   JungleBus error:', ctx)
    },
  })

  // Subscribe – this replays history from fromBlock onwards
  await client.Subscribe(
    JUNGLEBUS_SUB_ID,
    fromBlock,

    // onPublish – called for each historical + new transaction
    (tx) => {
      if (shouldStop) return

      totalProcessed++
      currentBlock = tx.block_height || currentBlock

      const rawHex: string = typeof tx.transaction === 'string'
        ? tx.transaction
        : Buffer.from(tx.transaction).toString('hex')

      if (!rawHex) return

      try {
        const outputs = parseRawTxOutputs(rawHex)
        const reading = decodeGaiaLogFromOutputs(
          outputs,
          tx.id,
          tx.block_height,
          tx.block_time
        )

        if (reading) {
          pendingBatch.push(reading)

          // Flush when batch is full (synchronous push, async flush)
          if (pendingBatch.length >= BATCH_SIZE) {
            flushBatch().catch(() => {})
          }
        }
      } catch {
        // Skip malformed transactions
      }
    },

    // onStatus – block boundaries and control messages
    async (message) => {
      if (message.statusCode === ControlMessageStatusCode.BLOCK_DONE) {
        const block = message.block
        if (block > currentBlock) currentBlock = block

        const txCount = message.transactions ?? 0
        process.stdout.write(
          `\r   Block ${block.toLocaleString()} done (${txCount} tx) | ` +
          `Scanned: ${totalProcessed.toLocaleString()} | ` +
          `GaiaLog: ${totalGaiaLog.toLocaleString()} | ` +
          `Batch: ${pendingBatch.length}       `
        )

        // Flush at block boundaries
        if (pendingBatch.length > 0) {
          await flushBatch()
        }

      } else if (message.statusCode === ControlMessageStatusCode.WAITING) {
        // Caught up to chain tip – flush and report
        await flushBatch()
        console.log(`\n\n   Caught up to chain tip. Waiting for new blocks...`)
        console.log(`   Scanned: ${totalProcessed.toLocaleString()} | GaiaLog: ${totalGaiaLog.toLocaleString()}`)
        console.log('   Press Ctrl+C to stop.\n')

      } else if (message.statusCode === ControlMessageStatusCode.REORG) {
        console.log(`\n   REORG detected at block ${message.block}`)

      } else if (message.statusCode === ControlMessageStatusCode.ERROR) {
        console.error(`\n   JungleBus error: ${message.message}`)
      }
    },

    // onError
    (err) => {
      console.error('\n   Subscription error:', err)
    },

    // onMempool – live unconfirmed transactions
    (tx) => {
      if (shouldStop) return

      totalProcessed++

      const rawHex: string = typeof tx.transaction === 'string'
        ? tx.transaction
        : Buffer.from(tx.transaction).toString('hex')

      if (!rawHex) return

      try {
        const outputs = parseRawTxOutputs(rawHex)
        const reading = decodeGaiaLogFromOutputs(outputs, tx.id, 0, 0)

        if (reading) {
          pendingBatch.push(reading)
          if (pendingBatch.length >= BATCH_SIZE) {
            flushBatch().catch(() => {})
          }
        }
      } catch {}
    }
  )

  console.log('   Subscription active. Replaying from block', fromBlock.toLocaleString())
  console.log('   Press Ctrl+C to stop gracefully.')
  console.log()
}

// ── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async (signal: string) => {
  console.log(`\n\n   ${signal} received - flushing remaining batch...`)
  shouldStop = true

  if (flushTimer) clearInterval(flushTimer)
  await flushBatch()

  console.log()
  console.log('============================================================')
  console.log('  Backfill Summary')
  console.log('============================================================')
  console.log(`   Transactions scanned:  ${totalProcessed.toLocaleString()}`)
  console.log(`   GaiaLog readings:      ${totalGaiaLog.toLocaleString()}`)
  console.log(`   Last block:            ${currentBlock.toLocaleString()}`)

  try {
    const finalStats = await getIndexStats()
    console.log(`   Total in Supabase:     ${finalStats.totalReadings.toLocaleString()}`)
  } catch {}

  console.log()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
