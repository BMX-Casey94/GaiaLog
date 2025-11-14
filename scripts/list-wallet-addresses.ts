import 'dotenv/config'
import dotenv from 'dotenv'
import { PrivateKey as SDKPrivateKey } from '@bsv/sdk'

// Load .env.local first, then fallback to .env
dotenv.config({ path: '.env.local' })
dotenv.config()

async function main() {
  console.log('🔍 Listing configured wallet addresses...\n')

  const keys: Array<{ name: string; wif: string }> = []

  // Collect all configured keys
  if (process.env.BSV_PRIVATE_KEY) {
    keys.push({ name: 'BSV_PRIVATE_KEY (Primary)', wif: process.env.BSV_PRIVATE_KEY })
  }
  if (process.env.BSV_WALLET_1_PRIVATE_KEY) {
    keys.push({ name: 'BSV_WALLET_1_PRIVATE_KEY', wif: process.env.BSV_WALLET_1_PRIVATE_KEY })
  }
  if (process.env.BSV_WALLET_2_PRIVATE_KEY) {
    keys.push({ name: 'BSV_WALLET_2_PRIVATE_KEY', wif: process.env.BSV_WALLET_2_PRIVATE_KEY })
  }
  if (process.env.BSV_WALLET_3_PRIVATE_KEY) {
    keys.push({ name: 'BSV_WALLET_3_PRIVATE_KEY', wif: process.env.BSV_WALLET_3_PRIVATE_KEY })
  }

  if (keys.length === 0) {
    console.log('❌ No wallet private keys found in environment variables')
    console.log('   Expected: BSV_PRIVATE_KEY, BSV_WALLET_1_PRIVATE_KEY, BSV_WALLET_2_PRIVATE_KEY, BSV_WALLET_3_PRIVATE_KEY')
    process.exit(1)
  }

  const network = process.env.BSV_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
  console.log(`📡 Network: ${network}\n`)

  for (let i = 0; i < keys.length; i++) {
    const { name, wif } = keys[i]
    try {
      const sdkKey = SDKPrivateKey.fromWif(wif)
      const pub = sdkKey.toPublicKey()
      const address = pub.toAddress().toString()
      
      console.log(`Wallet ${i + 1}: ${name}`)
      console.log(`  Address: ${address}`)
      console.log(`  WIF: ${wif.substring(0, 8)}...${wif.substring(wif.length - 4)}`)
      console.log('')
    } catch (error) {
      console.log(`Wallet ${i + 1}: ${name}`)
      console.log(`  ❌ Error deriving address: ${error instanceof Error ? error.message : String(error)}`)
      console.log('')
    }
  }

  console.log(`✅ Found ${keys.length} configured wallet(s)`)
}

main().catch(console.error)




