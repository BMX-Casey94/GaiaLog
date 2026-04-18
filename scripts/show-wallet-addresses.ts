#!/usr/bin/env npx ts-node
/**
 * Show Wallet Addresses
 * 
 * Derives and displays the BSV addresses from your configured private keys.
 * Use these addresses for the Data Explorer indexer.
 * 
 * Usage:
 *   npx tsx scripts/show-wallet-addresses.ts
 */

import 'dotenv/config'
import dotenv from 'dotenv'
import path from 'path'
dotenv.config({ path: path.join(process.cwd(), '.env.local') })

import { PrivateKey } from '@bsv/sdk'

console.log()
console.log('═══════════════════════════════════════════════════════════')
console.log('  GaiaLog Wallet Addresses')
console.log('═══════════════════════════════════════════════════════════')
console.log()

const privateKeys = [
  { name: 'BSV_WALLET_1_PRIVATE_KEY', key: process.env.BSV_WALLET_1_PRIVATE_KEY },
  { name: 'BSV_WALLET_2_PRIVATE_KEY', key: process.env.BSV_WALLET_2_PRIVATE_KEY },
  { name: 'BSV_WALLET_3_PRIVATE_KEY', key: process.env.BSV_WALLET_3_PRIVATE_KEY },
]

let foundCount = 0

for (const { name, key } of privateKeys) {
  if (!key || key === 'your_private_key_1_here' || key === 'your_private_key_2_here' || key === 'your_private_key_3_here') {
    console.log(`❌ ${name}: Not configured`)
    continue
  }
  
  try {
    const privateKey = PrivateKey.fromWif(key)
    const address = privateKey.toAddress().toString()
    foundCount++
    
    const envVar = name.replace('PRIVATE_KEY', 'ADDRESS')
    console.log(`✅ ${envVar}=${address}`)
  } catch (error) {
    console.log(`❌ ${name}: Invalid key format`)
  }
}

console.log()

if (foundCount > 0) {
  console.log('Add the above addresses to your environment file to enable explorer sync.')
  console.log()
  console.log('Then run: npm run explorer:sync')
} else {
  console.log('No valid private keys found. Configure your wallet keys in your environment file first.')
}

console.log()

