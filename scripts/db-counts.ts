import 'dotenv/config'
import { query } from '@/lib/db'

async function main() {
  try {
    const tables = [
      'tx_log',
      'air_quality_readings',
      'water_level_readings',
      'seismic_readings',
      'advanced_metrics_readings',
    ]
    for (const t of tables) {
      const { rows } = await query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM ${t}`)
      console.log(`${t}:`, rows[0]?.c ?? 0)
    }
    process.exit(0)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

main()


