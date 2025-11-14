import dotenv from 'dotenv'
import { validateGaiaLog } from '@/lib/opreturn-validator'

dotenv.config({ path: '.env.local' })
dotenv.config()

function getArg(flag: string): string | undefined {
	const i = process.argv.findIndex(a => a === flag || a === flag.replace(/^--/, '-'))
	return i >= 0 ? process.argv[i + 1] : undefined
}

async function fetchJson(url: string) {
	const res = await fetch(url)
	if (!res.ok) throw new Error(`${url} -> ${res.status}`)
	return await res.json()
}

async function listAddressTxs(net: string, addr: string): Promise<Array<{ tx_hash: string; height: number }>> {
	// Try /txs first; if 404, fall back to /history
	const base = `https://api.whatsonchain.com/v1/bsv/${net}/address/${addr}`
	let res = await fetch(`${base}/txs`)
	if (res.status === 404) {
		res = await fetch(`${base}/history`)
	}
	if (!res.ok) throw new Error(`${base}/txs -> ${res.status}`)
	const data = await res.json()
	// Normalise shape to { tx_hash, height }
	if (Array.isArray(data) && data.length && data[0]?.tx_hash) {
		return data as Array<{ tx_hash: string; height: number }>
	}
	if (Array.isArray(data) && typeof data[0] === 'string') {
		return (data as string[]).map(txid => ({ tx_hash: txid, height: 0 }))
	}
	return []
}

async function main() {
	// Ensure env is loaded before importing modules that read env at init time
	dotenv.config({ path: '.env.local' })
	dotenv.config()
	const { blockchainService } = await import('@/lib/blockchain')
	const { bsvConfig } = await import('@/lib/bsv-config')

	const txid = getArg('--txid') || getArg('-t')
	const forcedAddr = getArg('--address') || getArg('-a')
	const net = process.env.BSV_NETWORK === 'mainnet' ? 'main' : 'test'

	if (txid) {
		const j = await fetchJson(`https://api.whatsonchain.com/v1/bsv/${net}/tx/${txid}`)
		const vout = Array.isArray(j?.vout) ? j.vout : []
		const opret = vout.find((o: any) => typeof o?.scriptPubKey?.asm === 'string' && o.scriptPubKey.asm.includes('OP_RETURN'))
		if (!opret) throw new Error('No OP_RETURN output found')
		const scriptHex = (opret.scriptPubKey && (opret.scriptPubKey.hex || '')) as string
		if (!scriptHex) throw new Error('Missing scriptPubKey.hex for OP_RETURN output')
		const result = validateGaiaLog(scriptHex)
		console.log('✅ Valid GaiaLog output')
		console.log(JSON.stringify(result, null, 2))
		return
	}

	// No txid specified: scan recent txs for the writer address or all configured addresses
	const addresses: string[] = []
	if (forcedAddr) {
		addresses.push(forcedAddr)
	} else {
		// Primary writer address (derived)
		const addr = blockchainService.getAddress()
		if (addr) addresses.push(addr)
		// All configured WIFs -> derive addresses
		const keys = bsvConfig.wallets.privateKeys || []
		if (keys.length > 0) {
			try {
				const { PrivateKey: SDKPrivateKey } = await import('@bsv/sdk')
				for (const wif of keys) {
					try {
						const sdkKey = SDKPrivateKey.fromWif(wif)
						const a = sdkKey.toPublicKey().toAddress().toString()
						if (!addresses.includes(a)) addresses.push(a)
					} catch {}
				}
			} catch {}
		}
	}
	if (addresses.length === 0) throw new Error('Writer address not configured')

	for (const a of addresses) {
		const txs = await listAddressTxs(net, a)
		for (const t of txs.slice(0, 50)) {
			try {
				const j = await fetchJson(`https://api.whatsonchain.com/v1/bsv/${net}/tx/${t.tx_hash}`)
				const vout = Array.isArray(j?.vout) ? j.vout : []
				const opret = vout.find((o: any) => typeof o?.scriptPubKey?.asm === 'string' && o.scriptPubKey.asm.includes('OP_RETURN'))
				if (!opret) continue
				const scriptHex = (opret.scriptPubKey && (opret.scriptPubKey.hex || '')) as string
				if (!scriptHex) continue
				const result = validateGaiaLog(scriptHex)
				console.log(`✅ Valid GaiaLog output: ${t.tx_hash} (address ${a})`)
				console.log(JSON.stringify(result, null, 2))
				return
			} catch {
				// try next
			}
		}
	}
	throw new Error('No valid GaiaLog outputs found in recent transactions for any configured address')
}

main().catch((e) => {
	console.error('❌ Validation failed:', e && (e as Error).message ? (e as Error).message : e)
	process.exit(1)
})


