#!/usr/bin/env npx ts-node
/**
 * GaiaLog Explorer Sync
 *
 * Scans configured wallet addresses via WhatsonChain history endpoints and
 * writes decoded GaiaLog readings through the configured explorer write path.
 *
 * Usage:
 *   npm run explorer:sync
 *   npx tsx scripts/run-explorer-sync.ts
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.join(process.cwd(), '.env.local') })

import { ExplorerSyncWorker } from '../lib/explorer-sync'
import { getIndexStats } from '../lib/supabase-explorer'

console.log()
console.log('═══════════════════════════════════════════════════════════')
console.log('  GaiaLog Explorer Sync')
console.log('  WhatsonChain address-history indexer')
console.log('═══════════════════════════════════════════════════════════')
console.log()

const addresses = [
  process.env.BSV_WALLET_1_ADDRESS,
  process.env.BSV_WALLET_2_ADDRESS,
  process.env.BSV_WALLET_3_ADDRESS,
].filter(Boolean) as string[]

if (addresses.length === 0) {
  console.error('Error: No wallet addresses configured')
  console.error()
  console.error('Add these to your environment before running explorer sync:')
  console.error('  BSV_WALLET_1_ADDRESS=your_first_wallet_address')
  console.error('  BSV_WALLET_2_ADDRESS=your_second_wallet_address')
  console.error('  BSV_WALLET_3_ADDRESS=your_third_wallet_address')
  console.error()
  console.error('You can derive them from your configured WIFs with:')
  console.error('  npx tsx scripts/show-wallet-addresses.ts')
  console.error()
  process.exit(1)
}

console.log(`Network: ${process.env.BSV_NETWORK || 'testnet'}`)
console.log(`Addresses: ${addresses.length}`)
addresses.forEach((addr, i) => {
  console.log(`   ${i + 1}. ${addr.substring(0, 8)}...${addr.slice(-6)}`)
})
if (process.env.EXPLORER_SYNC_START_BLOCK) {
  console.log(`Start block: ${process.env.EXPLORER_SYNC_START_BLOCK}`)
}
if (process.env.EXPLORER_SYNC_BATCH_SIZE) {
  console.log(`Batch size: ${process.env.EXPLORER_SYNC_BATCH_SIZE}`)
}
console.log()

async function main() {
  try {
    const stats = await getIndexStats()
    console.log('Current explorer index:')
    console.log(`   Readings: ${stats.totalReadings}`)
    console.log(`   Last updated: ${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : 'Never'}`)
  } catch {
    console.log('No existing explorer index found or stats unavailable')
  }
  console.log()

  const worker = new ExplorerSyncWorker(addresses)

  const shutdown = async (signal: string) => {
    console.log()
    console.log(`${signal} received, shutting down explorer sync...`)
    await worker.stop()

    try {
      const finalStats = await getIndexStats()
      console.log()
      console.log('Final explorer index:')
      console.log(`   Readings: ${finalStats.totalReadings}`)
    } catch {}

    console.log()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  console.log('Starting explorer sync...')
  console.log('Press Ctrl+C to stop')
  console.log()

  try {
    await worker.start()

    try {
      const finalStats = await getIndexStats()
      console.log()
      console.log('Final explorer index:')
      console.log(`   Readings: ${finalStats.totalReadings}`)
    } catch {}

    process.exit(0)
  } catch (error) {
    console.error('Explorer sync error:', error)
    process.exit(1)
  }
}

main()
