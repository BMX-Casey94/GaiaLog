import { config } from 'dotenv'
import { resolve } from 'path'
import { query } from '../lib/db'

config({ path: resolve(process.cwd(), '.env.local') })

async function resetWaqiCursor() {
  try {
    console.log('🔄 Resetting WAQI cursor to 0...')
    
    const result = await query(
      `UPDATE provider_cursors 
       SET cursor = 0 
       WHERE provider = 'waqi'`
    )
    
    console.log('✅ WAQI cursor reset to 0')
    console.log(`   Rows updated: ${result.rows.length}`)
    
    // Verify
    const check = await query(
      `SELECT * FROM provider_cursors WHERE provider = 'waqi'`
    )
    console.log('📊 Current WAQI cursors:', check.rows)
    
    process.exit(0)
  } catch (error) {
    console.error('❌ Error:', error)
    process.exit(1)
  }
}

resetWaqiCursor()

