#!/usr/bin/env npx ts-node
/**
 * GaiaLog Transaction Indexer
 * 
 * Indexes GaiaLog transactions from your wallet addresses via WhatsonChain.
 * No database required - all data stored in data/explorer-index.json
 * 
 * Usage:
 *   npm run explorer:sync
 *   
 * Or directly:
 *   npx tsx scripts/run-junglebus-worker.ts
 * 
 * Environment variables:
 *   BSV_WALLET_1_ADDRESS - Your first wallet address
 *   BSV_WALLET_2_ADDRESS - Your second wallet address  
 *   BSV_WALLET_3_ADDRESS - Your third wallet address
 *   BSV_NETWORK - 'mainnet' or 'testnet' (default: testnet)
 *   EXPLORER_DATA_DIR - Directory for data files (default: ./data)
 */

// Load environment variables
import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.join(process.cwd(), '.env.local') })

import { JungleBusWorker } from '../lib/junglebus'
import { getIndexStats } from '../lib/supabase-explorer'

console.log()
console.log('═══════════════════════════════════════════════════════════')
console.log('  GaiaLog Transaction Indexer')
console.log('  Database-less Data Explorer')
console.log('═══════════════════════════════════════════════════════════')
console.log()

// Check configuration
const addresses = [
  process.env.BSV_WALLET_1_ADDRESS,
  process.env.BSV_WALLET_2_ADDRESS,
  process.env.BSV_WALLET_3_ADDRESS,
].filter(Boolean) as string[]

if (addresses.length === 0) {
  console.error('❌ Error: No wallet addresses configured')
  console.error()
  console.error('To configure, add to .env.local:')
  console.error('  BSV_WALLET_1_ADDRESS=your_first_wallet_address')
  console.error('  BSV_WALLET_2_ADDRESS=your_second_wallet_address')
  console.error('  BSV_WALLET_3_ADDRESS=your_third_wallet_address')
  console.error()
  console.error('You can find your wallet addresses by running:')
  console.error('  npx tsx scripts/show-wallet-addresses.ts')
  console.error()
  process.exit(1)
}

console.log(`🌐 Network: ${process.env.BSV_NETWORK || 'testnet'}`)
console.log(`📫 Addresses: ${addresses.length}`)
addresses.forEach((addr, i) => {
  console.log(`   ${i + 1}. ${addr.substring(0, 8)}...${addr.slice(-6)}`)
})
console.log(`📁 Data dir: ${process.env.EXPLORER_DATA_DIR || './data'}`)
console.log()

// Main async function
async function main() {
  // Show current index stats (async - Supabase backed)
  try {
    const stats = await getIndexStats()
    console.log('📊 Current Index (Supabase):')
    console.log(`   Readings: ${stats.totalReadings}`)
    console.log(`   Last updated: ${stats.lastUpdated ? new Date(stats.lastUpdated).toLocaleString() : 'Never'}`)
  } catch {
    console.log('📊 No existing index found - starting fresh')
  }
  console.log()

  // Create worker
  const worker = new JungleBusWorker(addresses)

  // Handle shutdown
  const shutdown = async (signal: string) => {
    console.log()
    console.log(`🛑 ${signal} received, shutting down...`)
    await worker.stop()
    
    // Show final stats
    try {
      const finalStats = await getIndexStats()
      console.log()
      console.log('📊 Final Index:')
      console.log(`   Readings: ${finalStats.totalReadings}`)
    } catch {}
    
    console.log()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Start indexing
  console.log('🔄 Starting transaction indexer (WoC small sync)...')
  console.log('   For full backfill: npm run explorer:backfill')
  console.log('   Press Ctrl+C to stop')
  console.log()

  try {
    await worker.start()
    
    // Show final stats after completion
    try {
      const finalStats = await getIndexStats()
      console.log()
      console.log('📊 Final Index:')
      console.log(`   Readings: ${finalStats.totalReadings}`)
    } catch {}
    process.exit(0)
  } catch (error) {
    console.error('❌ Indexer error:', error)
    process.exit(1)
  }
}

// Run main
main()
