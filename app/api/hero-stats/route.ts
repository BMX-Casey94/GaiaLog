import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { heroStatsCache } from '@/lib/stats-cache'
import { blockchainService } from '@/lib/blockchain'

export const runtime = 'nodejs'

export async function GET() {
  try {
    // Try to get cached stats first with fallback to stale data (15s cache for faster updates)
    const cachedStats = await heroStatsCache.getStats(async () => {
      let airQuality: { aqi: number | null; collected_at: string | null } = { aqi: null, collected_at: null }
      let txCount = 0
      let latestTx: string | null = null

      // Use more efficient parallel queries
      try {
        // Run all queries in parallel for better performance
        const [airQualityResult, txCountResult, latestTxResult] = await Promise.all([
          query(`SELECT aqi, collected_at
                 FROM air_quality_readings
                 WHERE aqi IS NOT NULL
                 ORDER BY collected_at DESC
                 LIMIT 1`),
          // Use PostgreSQL's table stats for fast approximate counts. Prefer n_live_tup when available
          // (updated by autovacuum/analyze), fallback to reltuples estimate from pg_class.
          query(`
            SELECT COALESCE(ps.n_live_tup::bigint, pc.reltuples::bigint) AS count
            FROM pg_class pc
            LEFT JOIN pg_stat_all_tables ps ON ps.relname = pc.relname
            WHERE pc.relname = 'tx_log'
          `),
          
          query(`SELECT COALESCE(onchain_at, collected_at) as timestamp
                 FROM tx_log
                 WHERE status IN ('pending', 'confirmed')
                   AND onchain_at IS NOT NULL
                 ORDER BY onchain_at DESC
                 LIMIT 1`)
        ])

        airQuality = airQualityResult.rows[0] || airQuality
        txCount = parseInt(txCountResult.rows[0]?.count || '0')
        latestTx = latestTxResult.rows[0]?.timestamp || null

      } catch (dbErr) {
        // Fallback: Read directly from blockchain (WOC)
        try {
          const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
          const addr = blockchainService.getAddress()
          if (addr) {
            const base = `https://api.whatsonchain.com/v1/bsv/${net}/address/${addr}`
            let listRes = await fetch(`${base}/txs`)
            if (listRes.status === 404) listRes = await fetch(`${base}/history`)
            if (listRes.ok) {
              const txsRaw: any = await listRes.json()
              const txs: { tx_hash: string; height: number }[] = Array.isArray(txsRaw)
                ? (txsRaw[0]?.tx_hash ? txsRaw : (typeof txsRaw[0] === 'string' ? txsRaw.map((id: string) => ({ tx_hash: id, height: 0 })) : []))
                : []
              // Approximate count: number of transactions sent by our writer address (bounded to recent list)
              txCount = Array.isArray(txs) ? txs.length : 0
              const candidates = txs.slice(0, 25)
              for (const t of candidates) {
                const txRes = await fetch(`https://api.whatsonchain.com/v1/bsv/${net}/tx/${t.tx_hash}`)
                if (!txRes.ok) continue
              const j = await txRes.json()
              const vout = Array.isArray(j?.vout) ? j.vout : []
              const opret = vout.find((o: any) => typeof o?.scriptPubKey?.asm === 'string' && o.scriptPubKey.asm.includes('OP_RETURN'))
              if (!opret) continue
              const parts = String(opret.scriptPubKey.asm).split(' ')
              const iret = parts.indexOf('OP_RETURN')
              if (iret < 0) continue
              const pushes = parts.slice(iret + 1)
              if (pushes.length < 3) continue
              const tagHex = pushes[0]
              const dataHex = pushes[2]
              const tag = Buffer.from(tagHex, 'hex').toString('utf8')
              if (tag !== 'GaiaLog') continue
              // Optional gzip flag
              const extras = pushes.slice(3)
              const encodingHex = Buffer.from('encoding=gzip', 'utf8').toString('hex')
              const isGzip = extras.includes(encodingHex)
                try {
                const raw = Buffer.from(dataHex, 'hex')
                const bytes = isGzip ? (await import('zlib')).gunzipSync(raw) : raw
                const txt = bytes.toString('utf8')
                  const parsed = JSON.parse(txt)
                  if (!latestTx && parsed?.timestamp) latestTx = parsed.timestamp
                  if (parsed?.data_type === 'air_quality' && airQuality.aqi == null) {
                    const payload = parsed?.payload || {}
                    airQuality = {
                      aqi: payload.air_quality_index ?? null,
                      collected_at: parsed.timestamp ?? null
                    }
                  }
                  if (airQuality.aqi != null && latestTx) break
                } catch {}
              }
            }
          }
        } catch (chainErr) {
          // Continue with defaults
        }
      }

      return {
        airQuality,
        blockchain: {
          totalTransactions: txCount,
          lastTransaction: latestTx,
        }
      }
    })

    const cacheAge = heroStatsCache.getCacheAge()
    const isStale = cacheAge ? cacheAge > 30000 : false

    return NextResponse.json({
      success: true,
      data: {
        airQuality: {
          aqi: cachedStats.airQuality.aqi,
          lastUpdated: cachedStats.airQuality.collected_at,
        },
        blockchain: {
          totalTransactions: cachedStats.blockchain.totalTransactions,
          lastTransaction: cachedStats.blockchain.lastTransaction,
        },
      },
      cached: true,
      cacheAge: cacheAge,
      stale: isStale
    })

  } catch (error) {
    console.error('Error fetching hero stats:', error)
    
    // Return stale cache as last resort
    const stale = heroStatsCache.getStale()
    if (stale) {
      return NextResponse.json({
        success: true,
        data: {
          airQuality: {
            aqi: stale.airQuality.aqi,
            lastUpdated: stale.airQuality.collected_at,
          },
          blockchain: {
            totalTransactions: stale.blockchain.totalTransactions,
            lastTransaction: stale.blockchain.lastTransaction,
          },
        },
        cached: true,
        stale: true,
        cacheAge: heroStatsCache.getCacheAge()
      })
    }

    // Final fallback with safe defaults
    return NextResponse.json({
      success: true,
      data: {
        airQuality: { aqi: null, lastUpdated: null },
        blockchain: { totalTransactions: 0, lastTransaction: null },
      },
      cached: false,
      error: 'Unable to fetch stats'
    })
  }
}


