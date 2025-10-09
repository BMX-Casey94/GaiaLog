#!/usr/bin/env tsx
import { config } from 'dotenv'
import { resolve } from 'path'
// Load .env.local explicitly (dotenv/config only loads .env by default)
config({ path: resolve(process.cwd(), '.env.local') })

import { query, dbPool } from '@/lib/db'

async function main() {
  console.log('🔍 Checking stations table...\n')
  
  // Debug: Check if environment variables are loaded
  console.log('📋 Environment check:')
  console.log(`  PGHOST: ${process.env.PGHOST || '❌ Missing'}`)
  console.log(`  PGUSER: ${process.env.PGUSER || '❌ Missing'}`)
  console.log(`  PGPASSWORD: ${process.env.PGPASSWORD ? '✅ Set (' + process.env.PGPASSWORD.substring(0, 4) + '...)' : '❌ Missing'}`)
  console.log(`  PGDATABASE: ${process.env.PGDATABASE || '❌ Missing'}`)
  console.log(`  PGPORT: ${process.env.PGPORT || '5432 (default)'}\n`)
  
  // Check if using correct Supabase format
  if (process.env.PGHOST?.includes('supabase.co')) {
    const correctFormat = process.env.PGUSER?.includes('.')
    if (!correctFormat) {
      console.log('⚠️  WARNING: For Supabase, PGUSER should be "postgres.[PROJECT_REF]" not just "postgres"\n')
    }
  }
  
  try {
    // Check if stations table exists
    const tableCheck = await query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'stations'
      );
    `)
    
    const exists = tableCheck.rows[0]?.exists
    
    if (!exists) {
      console.error('❌ ERROR: stations table does NOT exist!')
      console.log('\n💡 Solution: Run database migrations first:')
      console.log('   npx tsx scripts/migrate.ts')
      await dbPool.end()
      process.exit(1)
    }
    
    console.log('✅ stations table exists')
    
    // Check table structure
    const columns = await query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'stations'
      ORDER BY ordinal_position;
    `)
    
    console.log('\n📋 Table structure:')
    columns.rows.forEach(col => {
      console.log(`  - ${col.column_name}: ${col.data_type} ${col.is_nullable === 'YES' ? '(nullable)' : '(not null)'}`)
    })
    
    // Check current station count
    const count = await query(`SELECT COUNT(*) as count FROM stations`)
    console.log(`\n📊 Current stations: ${count.rows[0].count}`)
    
    // Check by provider
    const byProvider = await query(`
      SELECT provider, COUNT(*) as count 
      FROM stations 
      GROUP BY provider 
      ORDER BY count DESC
    `)
    
    if (byProvider.rows.length > 0) {
      console.log('\n📍 Stations by provider:')
      byProvider.rows.forEach(row => {
        console.log(`  - ${row.provider}: ${row.count}`)
      })
    }
    
    console.log('\n✅ Table check complete!')
    
  } catch (error) {
    console.error('❌ Error checking table:', error)
  }
  
  await dbPool.end()
}

main()

