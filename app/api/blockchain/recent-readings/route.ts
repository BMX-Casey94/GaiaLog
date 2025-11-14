import { NextRequest, NextResponse } from 'next/server'
import { query } from '../../../../lib/db'
import { blockchainService } from '@/lib/blockchain'

function getBSVNetwork(): string {
  return process.env.BSV_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
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
  try {
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
         AND type IN ('air_quality', 'water_levels', 'seismic_activity', 'advanced_metrics')
         AND collected_at > NOW() - INTERVAL '7 days'
       ORDER BY type, collected_at DESC`
    )

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

    // Fallback: read directly from chain for one recent entry per type
    const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'
    const addr = blockchainService.getAddress()
    if (!addr) {
      return NextResponse.json({ success: true, network, readings: [] })
    }
    const base = `https://api.whatsonchain.com/v1/bsv/${net}/address/${addr}`
    let listRes = await fetch(`${base}/txs`)
    if (listRes.status === 404) listRes = await fetch(`${base}/history`)
    if (!listRes.ok) throw new Error(`WOC address txs ${listRes.status}`)
    const txsRaw: any = await listRes.json()
    const txs: { tx_hash: string; height: number }[] = Array.isArray(txsRaw)
      ? (txsRaw[0]?.tx_hash ? txsRaw : (typeof txsRaw[0] === 'string' ? txsRaw.map((id: string) => ({ tx_hash: id, height: 0 })) : []))
      : []
    const wanted = new Set(['air_quality', 'water_levels', 'seismic_activity', 'advanced_metrics'])
    const found: Record<string, any> = {}
    const candidates = txs.slice(0, 50)
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
        const tpe = parsed?.data_type
        if (typeof tpe === 'string' && wanted.has(tpe) && !found[tpe]) {
          found[tpe] = {
            txid: t.tx_hash,
            type: tpe,
            timestamp: parsed?.timestamp || new Date().toISOString(),
            status: 'confirmed',
            data: { provider: parsed?.provider || 'unknown' },
          }
        }
        if (Object.keys(found).length === wanted.size) break
      } catch {}
    }
    const readings = Object.values(found)
      .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    return NextResponse.json({ success: true, network, readings })
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