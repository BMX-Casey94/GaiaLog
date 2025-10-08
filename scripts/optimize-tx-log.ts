/**
 * Optimize tx_log table for better query performance
 * This script provides the SQL commands to run in Supabase SQL Editor
 */

import * as fs from 'fs'
import * as path from 'path'

async function optimizeTxLog() {
  try {
    console.log('🔧 tx_log Table Optimization Guide')
    console.log('=====================================')
    console.log('')
    console.log('Since direct database connection is having issues, please run the following SQL commands in your Supabase SQL Editor:')
    console.log('')
    
    // Read the migration file
    const migrationPath = path.join(__dirname, '../db/migrations/0008_tx_log_performance.sql')
    const migrationSQL = fs.readFileSync(migrationPath, 'utf-8')
    
    console.log('📄 Copy and paste this SQL into Supabase SQL Editor:')
    console.log('')
    console.log('```sql')
    console.log(migrationSQL)
    console.log('```')
    console.log('')
    console.log('📊 This will create these indexes:')
    console.log('   - idx_tx_log_recent_readings (for blockchain explorer)')
    console.log('   - idx_tx_log_status_time (for status lookups)')
    console.log('   - idx_tx_log_type_time (for type-based queries)')
    console.log('')
    console.log('⚡ Expected performance improvement:')
    console.log('   - Query time: 30+ seconds → < 1 second')
    console.log('   - Dashboard will start working immediately')
    console.log('   - Blockchain verification will show recent transactions')
    console.log('')
    console.log('✅ After running the SQL, your dashboard should work!')
    console.log('')
    console.log('🔍 To verify it worked, check:')
    console.log('   1. Visit http://localhost:3000/#blockchain')
    console.log('   2. Should see recent transactions (not "No transactions found")')
    console.log('   3. API response time should be < 1 second')
    
    process.exit(0)
  } catch (error) {
    console.error('❌ Error reading migration file:', error)
    process.exit(1)
  }
}

optimizeTxLog()
