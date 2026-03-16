import { NextRequest, NextResponse } from 'next/server'
import { query } from '../../../../lib/db'
import { blockchainService } from '@/lib/blockchain'
import { DATA_FAMILY_DESCRIPTORS } from '@/lib/stream-registry'
import { getExplorerReadSource } from '@/lib/explorer-read-source'
import { getRecentReadingsByFamily } from '@/lib/overlay-explorer-repository'

function getBSVNetwork(): 'main' | 'test' {
  return process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
}

function isValidTxId(txid: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(txid)
}

interface TxLogRecord {
  txid: string
  type: string
  provider: string
  collected_at: string
  onchain_at: string | null
  status: string
}

export async function GET(req: NextRequest) {
  const network = getBSVNetwork()
  const wanted = Object.keys(DATA_FAMILY_DESCRIPTORS)
  try {
    // Overlay branch: when EXPLORER_READ_SOURCE=overlay, serve from overlay_explorer_readings
    const readSource = getExplorerReadSource()
    if (readSource === 'overlay') {
      try {
        const overlayRows = await getRecentReadingsByFamily(wanted)
        if (overlayRows.length > 0) {
          const readings = overlayRows
            .filter((r) => r.txid && isValidTxId(r.txid))
            .map((r) => ({
              txid: r.txid,
              type: r.data_family,
              timestamp: r.reading_ts,
              status: r.confirmed ? 'confirmed' : 'pending',
              data: { provider: r.provider_id || 'unknown' },
            }))
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          return NextResponse.json({ success: true, network, readings, source: 'overlay' })
        }
      } catch (overlayErr) {
        console.warn('Overlay recent-readings fallback:', overlayErr instanceof Error ? overlayErr.message : overlayErr)
      }
    }

    // Preferred: Use in-memory broadcast log for fresh TXIDs (no external reads)
    // Always pick the most recent per type; remain fixed until new data appears
    const local = blockchainService.getLocalTransactionLog()
    if (Array.isArray(local) && local.length > 0) {
      const readings = wanted.map((type) => {
        const items = local
          .filter((t) =>
            t.stream === type &&
            t.txid &&
            t.txid !== 'failed' &&
            isValidTxId(t.txid) &&
            (t.status === 'pending' || t.status === 'confirmed')
          )
          // Prefer most recent broadcasts
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        if (items.length === 0) return null
        const pick = items[0]
        return {
          txid: pick.txid,
          type,
          timestamp: new Date(pick.timestamp || Date.now()).toISOString(),
          status: pick.status,
          data: {
            provider: (pick.payload && (pick.payload.source || pick.payload.provider)) || 'unknown',
          },
        }
      }).filter(Boolean) as any[]
      
      if (readings.length > 0) {
        return NextResponse.json({ success: true, network, readings, source: 'local-log' })
      }
    }

    // Prefer DB when available (will be short-circuited to empty when GAIALOG_NO_DB=true)
    const result = await query<TxLogRecord>(
      `SELECT DISTINCT ON (type)
        txid, 
        type, 
        provider,
        collected_at,
        onchain_at,
        status
       FROM tx_log
       WHERE status IN ('pending', 'confirmed')
         AND txid IS NOT NULL
         AND LENGTH(txid) = 64
         AND type = ANY($1::text[])
         AND collected_at > NOW() - INTERVAL '7 days'
       ORDER BY type, collected_at DESC`
    , [wanted])

    if (Array.isArray(result.rows) && result.rows.length > 0) {
      const readings = result.rows
        .filter((tx) => {
          if (!tx.txid || tx.txid === 'failed' || tx.txid === '') return false
          if (tx.txid.startsWith('local_') || tx.txid.startsWith('error_')) return false
          if (!isValidTxId(tx.txid)) return false
          return true
        })
        .map((tx) => ({
          txid: tx.txid,
          type: tx.type,
          timestamp: tx.onchain_at || tx.collected_at,
          status: tx.status,
          data: {
            provider: tx.provider,
          },
        }))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      return NextResponse.json({ success: true, network, readings })
    }

    // If WoC reads are disabled, return empty rather than hitting WoC
    if (process.env.GAIALOG_DISABLE_WOC_READS === 'true') {
      return NextResponse.json({ success: true, network, readings: [] })
    }

    // Fallback: fast WoC lookup for latest of each type (no DB)
    // Use strict overall timeout to ensure quick responses
    const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
    const { findLatestByType } = await import('@/lib/woc-fetcher')

    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 8000)
    )

    const work = (async () => {
      const results = await Promise.allSettled(
        wanted.map(type => findLatestByType(net, type, 20))
      )

      const { isValidTxId } = await import('@/lib/utils')
      const toReading = (r: any, type: string) => {
        if (!r || !r.txid || !isValidTxId(r.txid)) return null
        return {
          txid: r.txid,
          type,
          timestamp: r.timestamp || new Date().toISOString(),
          status: 'confirmed',
          data: { provider: r.provider || 'unknown' },
        }
      }

      const readings = results
        .map((result, index) => result.status === 'fulfilled' && result.value ? toReading(result.value, wanted[index]) : null)
        .filter(Boolean) as any[]

      readings.sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      return readings
    })()

    const resultReadings = await Promise.race<[any[] | null]>([work as any, timeoutPromise as any])
    return NextResponse.json({ success: true, network, readings: resultReadings || [] })
  } catch (error) {
    // Final fallback: Return empty array
    return NextResponse.json({ 
      success: true, 
      network, 
      readings: [],
      error: 'Unable to fetch recent readings'
    })
  }
}