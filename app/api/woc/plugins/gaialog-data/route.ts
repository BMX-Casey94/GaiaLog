import { NextRequest, NextResponse } from 'next/server'
import { validateGaiaLog, parsePushes } from '@/lib/opreturn-validator'
import { promises as fs } from 'fs'
import path from 'path'

export const runtime = 'nodejs'

const WHATSONCHAIN_API_KEY = process.env.WHATSONCHAIN_API_KEY

type Cached = { html: string; at: number }
const CACHE_TTL_MS = 15 * 60 * 1000
const cache = new Map<string, Cached>()

function getCache(key: string): string | null {
	const c = cache.get(key)
	if (!c) return null
	if (Date.now() - c.at > CACHE_TTL_MS) {
		cache.delete(key)
		return null
	}
	return c.html
}

function setCache(key: string, html: string): void {
	if (cache.size > 200) {
		const first = cache.keys().next().value
		if (first) cache.delete(first)
	}
	cache.set(key, { html, at: Date.now() })
}

function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

function fmtIso(ts: unknown): string {
	const n = typeof ts === 'number' ? ts : Number(ts)
	if (!Number.isFinite(n)) return ''
	try {
		return new Date(n).toISOString()
	} catch {
		return ''
	}
}

function chip(label: string, value: unknown): string {
	if (value === undefined || value === null || value === '') return ''
	return `<span class="gl-chip"><span class="gl-chip-label">${escapeHtml(label)}:</span> <span class="gl-chip-val">${escapeHtml(value)}</span></span>`
}

function stat(label: string, value: unknown): string {
	if (value === undefined || value === null || value === '') return ''
	return `<div class="gl-stat">
		<div class="gl-stat-label">${escapeHtml(label)}</div>
		<div class="gl-stat-value">${escapeHtml(value)}</div>
	</div>`
}

const LABELS: Record<string, string> = {
	air_quality_index: 'Air Quality Index',
	fine_particulate_matter_pm25: 'Fine Particulate Matter (PM2.5)',
	coarse_particulate_matter_pm10: 'Coarse Particulate Matter (PM10)',
	carbon_monoxide: 'Carbon Monoxide (CO)',
	nitrogen_dioxide: 'Nitrogen Dioxide (NO2)',
	ozone: 'Ozone (O3)',
}

function renderTypeSections(dataType: string, payload: any): string {
	const sections: string[] = []
	const p = payload || {}

	// Extract meta for chips
	const loc = p?.location_ascii ?? p?.location
	const ts = p?.timestamp
	const dateISO = typeof ts === 'string' && ts.includes('T') ? ts : (fmtIso(ts) || '')
	const datePart = dateISO ? String(dateISO).slice(0, 10) : ''
	const timePart = dateISO ? (dateISO.includes('T') ? String(dateISO).slice(11, 19) : '') : ''

	if (dataType === 'air_quality') {
		sections.push(`
			<div class="gl-card">
				<div class="gl-card-title">Air Quality</div>
				<div class="gl-chips">
					${chip('Location', loc)}
					${chip('Date', datePart)}
					${chip('Time', timePart)}
				</div>
				<div class="gl-grid">
					${stat(LABELS.air_quality_index, p.air_quality_index)}
					${stat(LABELS.fine_particulate_matter_pm25, p.fine_particulate_matter_pm25)}
					${stat(LABELS.coarse_particulate_matter_pm10, p.coarse_particulate_matter_pm10)}
					${stat(LABELS.carbon_monoxide, p.carbon_monoxide)}
					${stat(LABELS.nitrogen_dioxide, p.nitrogen_dioxide)}
					${stat(LABELS.ozone, p.ozone)}
				</div>
			</div>
		`)
	} else if (dataType === 'water' || dataType === 'water_levels' || (p.river_level !== undefined || p.sea_level !== undefined)) {
		sections.push(`
			<div class="gl-card">
				<div class="gl-card-title">Water Levels</div>
				<div class="gl-chips">
					${chip('Location', loc)}
					${chip('Date', datePart)}
					${chip('Time', timePart)}
				</div>
				<div class="gl-grid">
					${stat('River Level (meters)', p.river_level ?? p.level ?? '')}
					${stat('Sea Level (meters)', p.sea_level ?? '')}
					${stat('Station ID', p.station_id ?? '')}
					${stat('Water Temperature (°C)', p.water_temperature_c ?? '')}
					${stat('Tide Height (meters)', p.tide_height ?? '')}
					${stat('Wave Height (meters)', p.wave_height_m ?? '')}
					${stat('Salinity (PSU)', p.salinity_psu ?? '')}
					${stat('Dissolved Oxygen (mg/L)', p.dissolved_oxygen_mg_l ?? '')}
					${stat('Turbidity (NTU)', p.turbidity_ntu ?? '')}
					${stat('Wind Speed (kph)', p.wind_speed_kph ?? '')}
					${stat('Wind Direction (deg)', p.wind_direction_deg ?? '')}
					${stat('Current Speed (m/s)', p.current_speed_ms ?? '')}
					${stat('Current Direction (deg)', p.current_direction_deg ?? '')}
				</div>
			</div>
		`)
	} else if (dataType === 'seismic' || (p.magnitude !== undefined && p.latitude !== undefined)) {
		sections.push(`
			<div class="gl-card">
				<div class="gl-card-title">Seismic Activity</div>
				<div class="gl-chips">
					${chip('Location', loc)}
					${chip('Date', datePart)}
					${chip('Time', timePart)}
				</div>
				<div class="gl-grid">
					${stat('Magnitude', p.magnitude)}
					${stat('Depth', p.depth_miles ?? p.depth)}
					${stat('Latitude', p.latitude)}
					${stat('Longitude', p.longitude)}
				</div>
			</div>
		`)
	} else if (dataType === 'advanced_metrics') {
		const entries = Object.entries(p).filter(([k]) => !['location', 'location_ascii', 'timestamp', 'payload_sha256', 'db_source_hash', 'source_hash'].includes(k))
		const labelMap: Record<string, string> = {
			humidity_pct: 'Humidity (Pct)',
			pressure_mb: 'Pressure (Mb)',
			temperature_c: 'Temperature (C)',
			uv_index: 'UV Index',
			wind_deg: 'Wind (Deg)',
			wind_kph: 'Wind (Kph)',
		}
		const stats = entries.slice(0, 24).map(([k, v]) => {
			const label = labelMap[k] || k.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
			return stat(label, typeof v === 'object' ? JSON.stringify(v) : v)
		}).join('')
		sections.push(`
			<div class="gl-card">
				<div class="gl-card-title">Advanced Metrics</div>
				<div class="gl-chips">
					${chip('Location', loc)}
					${chip('Date', datePart)}
					${chip('Time', timePart)}
				</div>
				<div class="gl-grid">
					${stats}
				</div>
			</div>
		`)
	}

	sections.push(`
		<details class="gl-card gl-details">
			<summary class="gl-card-title">Raw Payload</summary>
			<pre class="gl-pre">${escapeHtml(JSON.stringify(payload ?? {}, null, 2))}</pre>
		</details>
	`)

	return sections.join('\n')
}

export function renderHtml(opts: {
	txid?: string
	network?: string
	spendable: boolean
	hasHash: boolean
	isGzip: boolean
	json: any
	logoUrl?: string | null
}): string {
	const { txid, network, json, logoUrl } = opts
	const viewOnWoc = (txid && network)
		? `<a class="gl-btn" href="https://whatsonchain.com/tx/${escapeHtml(txid)}" target="_blank" rel="noopener">View on WhatsOnChain</a>`
		: ''

	return `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>GaiaLog Decode</title>
		<style>
			.gl-root{--bg:#170035;--fg:#ffffff;--muted:#ffffffcc;--card:rgba(255,255,255,0.08);--card-bd:rgba(255,255,255,0.12);
				font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;
				color:var(--fg);
				max-width:860px;margin:24px auto;border-radius:14px;padding:16px;
				background:
					radial-gradient(1200px 600px at -10% -20%, rgba(0,168,107,0.18), transparent 45%),
					linear-gradient(135deg, #170035 0%, #060313 55%, #170035 100%);
				box-shadow:0 10px 30px rgba(0,0,0,0.45);
				position:relative;
				overflow:hidden;
			}
			.gl-particles{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1}
			.gl-particle{position:absolute;border-radius:50%;background:radial-gradient(circle, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.5) 30%, transparent 70%);box-shadow:0 0 6px rgba(255,255,255,0.4),0 0 10px rgba(255,255,255,0.2);opacity:.35;animation:float 20s infinite ease-in-out}
			.gl-particle:nth-child(1){width:5px;height:5px;top:8%;left:12%;animation-duration:18s;animation-delay:0s}
			.gl-particle:nth-child(2){width:3px;height:3px;top:22%;left:78%;animation-duration:22s;animation-delay:2s}
			.gl-particle:nth-child(3){width:6px;height:6px;top:42%;left:8%;animation-duration:25s;animation-delay:4s}
			.gl-particle:nth-child(4){width:4px;height:4px;top:58%;left:72%;animation-duration:20s;animation-delay:1s}
			.gl-particle:nth-child(5){width:5px;height:5px;top:78%;left:28%;animation-duration:24s;animation-delay:3s}
			.gl-particle:nth-child(6){width:3px;height:3px;top:14%;left:48%;animation-duration:19s;animation-delay:5s}
			.gl-particle:nth-child(7){width:6px;height:6px;top:68%;left:58%;animation-duration:23s;animation-delay:2.5s}
			.gl-particle:nth-child(8){width:4px;height:4px;top:32%;left:88%;animation-duration:21s;animation-delay:1.5s}
			.gl-particle:nth-child(9){width:4px;height:4px;top:18%;left:35%;animation-duration:20s;animation-delay:3.5s}
			.gl-particle:nth-child(10){width:3px;height:3px;top:50%;left:92%;animation-duration:24s;animation-delay:1.2s}
			.gl-particle:nth-child(11){width:5px;height:5px;top:85%;left:15%;animation-duration:22s;animation-delay:4.5s}
			.gl-particle:nth-child(12){width:4px;height:4px;top:38%;left:42%;animation-duration:19s;animation-delay:2.8s}
			.gl-particle:nth-child(13){width:3px;height:3px;top:62%;left:20%;animation-duration:21s;animation-delay:0.5s}
			.gl-particle:nth-child(14){width:5px;height:5px;top:28%;left:65%;animation-duration:23s;animation-delay:3.2s}
			.gl-particle:nth-child(15){width:4px;height:4px;top:72%;left:82%;animation-duration:20s;animation-delay:1.8s}
			@keyframes float{0%,100%{transform:translate(0,0) scale(1);opacity:.35}25%{transform:translate(15px,-20px) scale(1.2);opacity:.45}50%{transform:translate(-10px,10px) scale(.85);opacity:.3}75%{transform:translate(20px,5px) scale(1.1);opacity:.4}}
			.gl-header{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:16px;text-align:center;position:relative;z-index:2}
			.gl-logo-wrap{position:relative;width:72px;height:72px;display:flex;align-items:center;justify-content:center}
			.gl-logo{width:72px;height:72px;border-radius:12px;object-fit:contain;position:relative;z-index:3}
			.gl-logo-wrap::before{content:'';position:absolute;width:80px;height:80px;border-radius:50%;border:2px solid transparent;border-top-color:#22d3ee;border-right-color:#2dd4bf;animation:glow-rotate 3s linear infinite;filter:drop-shadow(0 0 8px rgba(34,211,238,0.6)) drop-shadow(0 0 12px rgba(45,212,191,0.4));z-index:2}
			.gl-logo-wrap::after{content:'';position:absolute;width:80px;height:80px;border-radius:50%;border:2px solid transparent;border-bottom-color:#22d3ee;border-left-color:#2dd4bf;animation:glow-rotate 3s linear infinite reverse;filter:drop-shadow(0 0 6px rgba(34,211,238,0.5)) drop-shadow(0 0 10px rgba(45,212,191,0.3));z-index:2;opacity:.7}
			@keyframes glow-rotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
			.gl-title-big{font-size:26px;font-weight:800;letter-spacing:.3px;margin-top:4px}
			.gl-tagline{font-size:13px;font-style:italic;opacity:.75;margin-top:2px;text-align:center}
			.gl-footer{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);position:relative;z-index:2}
			.gl-footer-meta{font-size:11px;color:#999;opacity:.85}
			.gl-btn{display:inline-block;background:linear-gradient(135deg,#22d3ee,#2dd4bf);color:#0b0f2a;text-decoration:none;padding:6px 14px;border-radius:999px;font-weight:600;font-size:13px;border:0;box-shadow:0 4px 16px rgba(34,211,238,0.25);transition:transform 0.2s ease,box-shadow 0.2s ease}
			.gl-btn:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(34,211,238,0.35)}
			.gl-card{background:var(--card);border:1px solid var(--card-bd);border-radius:12px;padding:12px;margin:10px 0;
				backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);position:relative;z-index:2}
			.gl-card-title{font-weight:700;margin-bottom:8px;opacity:.95}
			.gl-chips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 14px;justify-content:space-between}
			.gl-chip{display:inline-flex;gap:4px;align-items:center;padding:3px 7px;border-radius:999px;background:rgba(255,255,255,0.08);border:1px solid var(--card-bd);flex:1;min-width:0;justify-content:center;font-size:12px;transition:background 0.2s ease,border-color 0.2s ease}
			.gl-chip:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.2)}
			.gl-chip-label{opacity:.85}
			.gl-chip-val{font-weight:700}
			.gl-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
			@media (min-width:640px){.gl-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
			.gl-stat{background:rgba(255,255,255,0.06);border:1px solid var(--card-bd);border-radius:10px;padding:10px;transition:background 0.2s ease,border-color 0.2s ease,transform 0.2s ease}
			.gl-stat:hover{background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.2);transform:translateY(-2px)}
			.gl-stat-label{font-size:12px;color:#ffffffcc;margin-bottom:6px}
			.gl-stat-value{font-size:16px;font-weight:700;word-break:break-word}
			.gl-pre{white-space:pre-wrap;word-wrap:break-word;margin:0;color:#fff;background:rgba(0,0,0,0.25);border-radius:10px;padding:10px;border:1px solid var(--card-bd)}
			.gl-details summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;transition:opacity 0.2s ease}
			.gl-details summary:hover{opacity:.85}
			.gl-details summary::-webkit-details-marker{display:none}
			.gl-details summary:after{content:"Expand ▼";font-size:12px;background:rgba(167,243,208,0.15);color:#a7f3d0;padding:4px 10px;border-radius:999px;border:1px solid rgba(167,243,208,0.25);transition:background 0.2s ease,border-color 0.2s ease}
			.gl-details summary:hover:after{background:rgba(167,243,208,0.22);border-color:rgba(167,243,208,0.35)}
			.gl-details[open] summary:after{content:"Collapse ▲"}
		</style>
	</head>
	<body style="margin:0;padding-top:110px;padding-bottom:120px;background:linear-gradient(135deg, #170035 0%, #060313 60%, #170035 100%)">
		<div class="gl-root">
			<div class="gl-particles">
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
			</div>
			<div class="gl-header">
				${logoUrl ? `<div class="gl-logo-wrap"><img class="gl-logo" src="${logoUrl}" alt="GaiaLog" /></div>` : ''}
				<div>
					<div class="gl-title-big">GaiaLog</div>
					<div class="gl-tagline">Immutable Earth data, stored on-chain.</div>
				</div>
			</div>
			${renderTypeSections(String(json?.data_type ?? '').trim(), json?.payload)}
			<div class="gl-footer">
				<div class="gl-footer-meta">GaiaLog Data Decoder (Plugin) — v1.7</div>
				${viewOnWoc}
			</div>
		</div>
	</body>
</html>`
}

export function renderHomeHtml(opts: {
	logoUrl?: string | null
}): string {
	const { logoUrl } = opts
	return `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>GaiaLog Decoder</title>
		<style>
			.gl-root{--bg:#170035;--fg:#ffffff;--muted:#ffffffcc;--card:rgba(255,255,255,0.08);--card-bd:rgba(255,255,255,0.12);
				font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;
				color:var(--fg);max-width:860px;margin:24px auto;border-radius:14px;padding:16px;
				background:radial-gradient(1200px 600px at -10% -20%, rgba(0,168,107,0.18), transparent 45%),
					linear-gradient(135deg, #170035 0%, #060313 55%, #170035 100%);
				box-shadow:0 10px 30px rgba(0,0,0,0.45);position:relative;overflow:hidden;}
			.gl-particles{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1}
			.gl-particle{position:absolute;border-radius:50%;background:radial-gradient(circle, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.5) 30%, transparent 70%);box-shadow:0 0 6px rgba(255,255,255,0.4),0 0 10px rgba(255,255,255,0.2);opacity:.35;animation:float 20s infinite ease-in-out}
			.gl-particle:nth-child(1){width:5px;height:5px;top:8%;left:12%;animation-duration:18s;animation-delay:0s}
			.gl-particle:nth-child(2){width:3px;height:3px;top:22%;left:78%;animation-duration:22s;animation-delay:2s}
			.gl-particle:nth-child(3){width:6px;height:6px;top:42%;left:8%;animation-duration:25s;animation-delay:4s}
			.gl-particle:nth-child(4){width:4px;height:4px;top:58%;left:72%;animation-duration:20s;animation-delay:1s}
			.gl-particle:nth-child(5){width:5px;height:5px;top:78%;left:28%;animation-duration:24s;animation-delay:3s}
			.gl-particle:nth-child(6){width:3px;height:3px;top:14%;left:48%;animation-duration:19s;animation-delay:5s}
			.gl-particle:nth-child(7){width:6px;height:6px;top:68%;left:58%;animation-duration:23s;animation-delay:2.5s}
			.gl-particle:nth-child(8){width:4px;height:4px;top:32%;left:88%;animation-duration:21s;animation-delay:1.5s}
			.gl-particle:nth-child(9){width:4px;height:4px;top:18%;left:35%;animation-duration:20s;animation-delay:3.5s}
			.gl-particle:nth-child(10){width:3px;height:3px;top:50%;left:92%;animation-duration:24s;animation-delay:1.2s}
			.gl-particle:nth-child(11){width:5px;height:5px;top:85%;left:15%;animation-duration:22s;animation-delay:4.5s}
			.gl-particle:nth-child(12){width:4px;height:4px;top:38%;left:42%;animation-duration:19s;animation-delay:2.8s}
			.gl-particle:nth-child(13){width:3px;height:3px;top:62%;left:20%;animation-duration:21s;animation-delay:0.5s}
			.gl-particle:nth-child(14){width:5px;height:5px;top:28%;left:65%;animation-duration:23s;animation-delay:3.2s}
			.gl-particle:nth-child(15){width:4px;height:4px;top:72%;left:82%;animation-duration:20s;animation-delay:1.8s}
			@keyframes float{0%,100%{transform:translate(0,0) scale(1);opacity:.35}25%{transform:translate(15px,-20px) scale(1.2);opacity:.45}50%{transform:translate(-10px,10px) scale(.85);opacity:.3}75%{transform:translate(20px,5px) scale(1.1);opacity:.4}}
			.gl-header{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:16px;text-align:center;position:relative;z-index:2}
			.gl-logo-wrap{position:relative;width:72px;height:72px;display:flex;align-items:center;justify-content:center}
			.gl-logo{width:72px;height:72px;border-radius:12px;object-fit:contain;position:relative;z-index:3}
			.gl-logo-wrap::before{content:'';position:absolute;width:80px;height:80px;border-radius:50%;border:2px solid transparent;border-top-color:#22d3ee;border-right-color:#2dd4bf;animation:glow-rotate 3s linear infinite;filter:drop-shadow(0 0 8px rgba(34,211,238,0.6)) drop-shadow(0 0 12px rgba(45,212,191,0.4));z-index:2}
			.gl-logo-wrap::after{content:'';position:absolute;width:80px;height:80px;border-radius:50%;border:2px solid transparent;border-bottom-color:#22d3ee;border-left-color:#2dd4bf;animation:glow-rotate 3s linear infinite reverse;filter:drop-shadow(0 0 6px rgba(34,211,238,0.5)) drop-shadow(0 0 10px rgba(45,212,191,0.3));z-index:2;opacity:.7}
			@keyframes glow-rotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
			.gl-title-big{font-size:26px;font-weight:800;letter-spacing:.3px;margin-top:4px}
			.gl-tagline{font-size:13px;font-style:italic;opacity:.75;margin-top:2px;text-align:center}
			.gl-footer{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);position:relative;z-index:2}
			.gl-footer-meta{font-size:11px;color:#999;opacity:.85}
			.gl-card{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:12px;margin:10px 0;
				backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);position:relative;z-index:2;transition:background 0.2s ease,border-color 0.2s ease,transform 0.2s ease}
			.gl-card:hover{background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.2);transform:translateY(-2px)}
			.gl-card-title{font-weight:700;margin-bottom:8px;opacity:.95}
			.gl-home-content{text-align:center;line-height:1.6}
			.gl-home-content p{margin:12px 0;opacity:.9}
			.gl-home-content code{background:rgba(0,0,0,0.3);padding:2px 6px;border-radius:4px;font-size:13px;font-family:ui-monospace,monospace}
			.gl-showcase-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:16px 0}
			@media (max-width:640px){.gl-showcase-grid{grid-template-columns:1fr}}
			.gl-showcase-card{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;text-align:center;
				backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);transition:background 0.2s ease,border-color 0.2s ease,transform 0.2s ease}
			.gl-showcase-card:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.2);transform:translateY(-2px)}
			.gl-showcase-card-title{font-weight:700;font-size:15px;margin-bottom:6px;opacity:.95}
			.gl-showcase-card-desc{font-size:12px;opacity:.8;line-height:1.4}
			.gl-address-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:16px 0}
			@media (max-width:640px){.gl-address-grid{grid-template-columns:1fr}}
			.gl-address-card{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;text-align:center;
				backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);transition:background 0.2s ease,border-color 0.2s ease,transform 0.2s ease;
				text-decoration:none;color:inherit;display:block}
			.gl-address-card:hover{background:rgba(255,255,255,0.12);border-color:rgba(255,255,255,0.2);transform:translateY(-2px)}
			.gl-address-label{font-size:11px;opacity:.7;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap}
			.gl-address-value{font-size:11px;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.95;font-weight:500}
		</style>
	</head>
	<body style="margin:0;padding-top:110px;padding-bottom:120px;background:linear-gradient(135deg, #170035 0%, #060313 60%, #170035 100%)">
		<div class="gl-root">
			<div class="gl-particles">
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
			</div>
			<div class="gl-header">
				${logoUrl ? `<div class="gl-logo-wrap"><img class="gl-logo" src="${logoUrl}" alt="GaiaLog" /></div>` : ''}
				<div>
					<div class="gl-title-big">GaiaLog</div>
					<div class="gl-tagline">Immutable Earth data, stored on-chain.</div>
				</div>
			</div>
			<div class="gl-card">
				<div class="gl-home-content">
					<p style="margin-bottom:20px;font-size:12px;font-style:italic">
						This plugin decodes GaiaLog OP_RETURN transactions stored on the BSV blockchain.<br>
						It displays environmental data including air quality, water levels, seismic activity, and advanced metrics.
					</p>
				</div>
				<div class="gl-showcase-grid">
					<div class="gl-showcase-card">
						<div class="gl-showcase-card-title">Air Quality</div>
						<div class="gl-showcase-card-desc">
							Real-time air quality metrics including AQI, PM2.5, PM10, and pollutant levels. 
							Track carbon monoxide, nitrogen dioxide, and ozone concentrations. 
							Monitor air quality with location and timestamp data.
						</div>
					</div>
					<div class="gl-showcase-card">
						<div class="gl-showcase-card-title">Water Levels</div>
						<div class="gl-showcase-card-desc">
							River and sea level measurements with station data and timestamps. 
							Monitor water temperature, tide height, wind speed, and wind direction. 
							View detailed station information and environmental conditions.
						</div>
					</div>
					<div class="gl-showcase-card">
						<div class="gl-showcase-card-title">Seismic Activity</div>
						<div class="gl-showcase-card-desc">
							Earthquake data including magnitude, depth, and geographic coordinates. 
							Monitor seismic events with location tracking. 
							Track earthquake depth measurements in miles and coordinates.
						</div>
					</div>
					<div class="gl-showcase-card">
						<div class="gl-showcase-card-title">Advanced Metrics</div>
						<div class="gl-showcase-card-desc">
							Comprehensive environmental data including temperature, humidity, and pressure. 
							Monitor UV index, wind speed, wind direction, and soil moisture. 
							Track wildfire risk, environmental quality scores, and more.
						</div>
					</div>
				</div>
				<div class="gl-home-content" style="margin-top:24px">
					<p style="margin-bottom:12px;font-weight:600;white-space:nowrap">Browse Transactions by Address:</p>
				</div>
				<div class="gl-address-grid">
					<a href="https://whatsonchain.com/address/13S6zUA88PtDNy9DKHZuh3QQmy4d4eN4Se" target="_blank" rel="noopener" class="gl-address-card">
						<div class="gl-address-label">Address</div>
						<div class="gl-address-value">13S6zUA88PtDNy9DKHZuh3QQmy4d4eN4Se</div>
					</a>
					<a href="https://whatsonchain.com/address/127HLeWpr66JU3SDmQJ9dmjBo6RgNsRU1w" target="_blank" rel="noopener" class="gl-address-card">
						<div class="gl-address-label">Address</div>
						<div class="gl-address-value">127HLeWpr66JU3SDmQJ9dmjBo6RgNsRU1w</div>
					</a>
					<a href="https://whatsonchain.com/address/1Jm2t7cmarKskV65UsigAr7tveS5WhPdJS" target="_blank" rel="noopener" class="gl-address-card">
						<div class="gl-address-label">Address</div>
						<div class="gl-address-value">1Jm2t7cmarKskV65UsigAr7tveS5WhPdJS</div>
					</a>
				</div>
				<div class="gl-home-content" style="margin-top:24px">
					<p style="opacity:.75;font-size:13px">
						For more information, visit <a href="https://gaialog.world" target="_blank" rel="noopener" style="color:#22d3ee;text-decoration:none">gaialog.world</a>
					</p>
				</div>
			</div>
			<div class="gl-footer">
				<div class="gl-footer-meta">GaiaLog Data Decoder (Plugin) — v1.7</div>
			</div>
		</div>
	</body>
</html>`
}

export function renderErrorHtml(opts: {
	txid?: string
	network?: string
	message: string
	logoUrl?: string | null
}): string {
	const { txid, network, message, logoUrl } = opts
	const viewOnWoc = (txid && network)
		? `<a class="gl-btn" href="https://whatsonchain.com/tx/${escapeHtml(txid)}" target="_blank" rel="noopener">View on WhatsOnChain</a>`
		: ''
	return `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>GaiaLog Decode</title>
		<style>
			.gl-root{--bg:#170035;--fg:#ffffff;--muted:#ffffffcc;--card:rgba(255,255,255,0.08);--card-bd:rgba(255,255,255,0.12);
				font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;
				color:var(--fg);
				max-width:860px;margin:24px auto;border-radius:14px;padding:16px;
				background:
					radial-gradient(1200px 600px at -10% -20%, rgba(0,168,107,0.18), transparent 45%),
					linear-gradient(135deg, #170035 0%, #060313 55%, #170035 100%);
				box-shadow:0 10px 30px rgba(0,0,0,0.45);
				position:relative;
				overflow:hidden;
			}
			.gl-particles{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:1}
			.gl-particle{position:absolute;border-radius:50%;background:radial-gradient(circle, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.5) 30%, transparent 70%);box-shadow:0 0 6px rgba(255,255,255,0.4),0 0 10px rgba(255,255,255,0.2);opacity:.35;animation:float 20s infinite ease-in-out}
			.gl-particle:nth-child(1){width:5px;height:5px;top:8%;left:12%;animation-duration:18s;animation-delay:0s}
			.gl-particle:nth-child(2){width:3px;height:3px;top:22%;left:78%;animation-duration:22s;animation-delay:2s}
			.gl-particle:nth-child(3){width:6px;height:6px;top:42%;left:8%;animation-duration:25s;animation-delay:4s}
			.gl-particle:nth-child(4){width:4px;height:4px;top:58%;left:72%;animation-duration:20s;animation-delay:1s}
			.gl-particle:nth-child(5){width:5px;height:5px;top:78%;left:28%;animation-duration:24s;animation-delay:3s}
			.gl-particle:nth-child(6){width:3px;height:3px;top:14%;left:48%;animation-duration:19s;animation-delay:5s}
			.gl-particle:nth-child(7){width:6px;height:6px;top:68%;left:58%;animation-duration:23s;animation-delay:2.5s}
			.gl-particle:nth-child(8){width:4px;height:4px;top:32%;left:88%;animation-duration:21s;animation-delay:1.5s}
			.gl-particle:nth-child(9){width:4px;height:4px;top:18%;left:35%;animation-duration:20s;animation-delay:3.5s}
			.gl-particle:nth-child(10){width:3px;height:3px;top:50%;left:92%;animation-duration:24s;animation-delay:1.2s}
			.gl-particle:nth-child(11){width:5px;height:5px;top:85%;left:15%;animation-duration:22s;animation-delay:4.5s}
			.gl-particle:nth-child(12){width:4px;height:4px;top:38%;left:42%;animation-duration:19s;animation-delay:2.8s}
			.gl-particle:nth-child(13){width:3px;height:3px;top:62%;left:20%;animation-duration:21s;animation-delay:0.5s}
			.gl-particle:nth-child(14){width:5px;height:5px;top:28%;left:65%;animation-duration:23s;animation-delay:3.2s}
			.gl-particle:nth-child(15){width:4px;height:4px;top:72%;left:82%;animation-duration:20s;animation-delay:1.8s}
			@keyframes float{0%,100%{transform:translate(0,0) scale(1);opacity:.35}25%{transform:translate(15px,-20px) scale(1.2);opacity:.45}50%{transform:translate(-10px,10px) scale(.85);opacity:.3}75%{transform:translate(20px,5px) scale(1.1);opacity:.4}}
			.gl-header{display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:16px;text-align:center;position:relative;z-index:2}
			.gl-logo-wrap{position:relative;width:72px;height:72px;display:flex;align-items:center;justify-content:center}
			.gl-logo{width:72px;height:72px;border-radius:12px;object-fit:contain;position:relative;z-index:3}
			.gl-logo-wrap::before{content:'';position:absolute;width:80px;height:80px;border-radius:50%;border:2px solid transparent;border-top-color:#22d3ee;border-right-color:#2dd4bf;animation:glow-rotate 3s linear infinite;filter:drop-shadow(0 0 8px rgba(34,211,238,0.6)) drop-shadow(0 0 12px rgba(45,212,191,0.4));z-index:2}
			.gl-logo-wrap::after{content:'';position:absolute;width:80px;height:80px;border-radius:50%;border:2px solid transparent;border-bottom-color:#22d3ee;border-left-color:#2dd4bf;animation:glow-rotate 3s linear infinite reverse;filter:drop-shadow(0 0 6px rgba(34,211,238,0.5)) drop-shadow(0 0 10px rgba(45,212,191,0.3));z-index:2;opacity:.7}
			@keyframes glow-rotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
			.gl-title-big{font-size:26px;font-weight:800;letter-spacing:.3px;margin-top:4px}
			.gl-tagline{font-size:13px;font-style:italic;opacity:.75;margin-top:2px;text-align:center}
			.gl-footer{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:16px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);position:relative;z-index:2}
			.gl-footer-meta{font-size:11px;color:#999;opacity:.85}
			.gl-btn{display:inline-block;background:linear-gradient(135deg,#22d3ee,#2dd4bf);color:#0b0f2a;text-decoration:none;padding:6px 14px;border-radius:999px;font-weight:600;font-size:13px;border:0;box-shadow:0 4px 16px rgba(34,211,238,0.25);transition:transform 0.2s ease,box-shadow 0.2s ease}
			.gl-btn:hover{transform:translateY(-2px);box-shadow:0 6px 24px rgba(34,211,238,0.35)}
			.gl-card{background:var(--card);border:1px solid var(--card-bd);border-radius:12px;padding:12px;margin:10px 0;
				backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);position:relative;z-index:2}
			.gl-card-title{font-weight:700;margin-bottom:8px;opacity:.95}
		</style>
	</head>
	<body style="margin:0;padding-top:110px;padding-bottom:120px;background:linear-gradient(135deg, #170035 0%, #060313 60%, #170035 100%)">
		<div class="gl-root">
			<div class="gl-particles">
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
				<div class="gl-particle"></div><div class="gl-particle"></div><div class="gl-particle"></div>
			</div>
			<div class="gl-header">
				${logoUrl ? `<div class="gl-logo-wrap"><img class="gl-logo" src="${logoUrl}" alt="GaiaLog" /></div>` : ''}
				<div>
					<div class="gl-title-big">GaiaLog</div>
					<div class="gl-tagline">Immutable Earth data, stored on-chain.</div>
				</div>
			</div>
			<div class="gl-card" style="display:flex;align-items:center;justify-content:center;min-height:140px;text-align:center">
				<div>
					<div class="gl-card-title">GaiaLog Decoder</div>
					<div style="font-size:15px;opacity:.95;line-height:1.6">${message.includes('|') ? message.split('|').map((line: string) => escapeHtml(line.trim())).join('<br>') : escapeHtml(message)}</div>
				</div>
			</div>
			<div class="gl-footer">
				<div class="gl-footer-meta">GaiaLog Data Decoder (Plugin) — v1.7</div>
				${viewOnWoc}
			</div>
		</div>
	</body>
</html>`
}

async function fetchTxAndFindScriptHex(network: string, txid: string, vout?: number): Promise<string> {
	const headers: Record<string, string> = {}
	if (WHATSONCHAIN_API_KEY) headers['woc-api-key'] = WHATSONCHAIN_API_KEY
	const res = await fetch(`https://api.whatsonchain.com/v1/bsv/${network}/tx/${txid}`, { headers })
	if (!res.ok) throw new Error(`Failed to fetch TX: ${res.status}`)
	const j = await res.json()
	const outs = Array.isArray(j?.vout) ? j.vout : []

	if (typeof vout === 'number') {
		const o = outs.find((x: any) => x?.n === vout)
		const hex = o?.scriptPubKey?.hex
		if (typeof hex === 'string' && hex.length > 0) return hex
		throw new Error('Specified vout not found or missing script hex')
	}

	for (const o of outs) {
		const asm = String(o?.scriptPubKey?.asm || '')
		if (!asm.includes('OP_RETURN')) continue
		const hex = o?.scriptPubKey?.hex
		if (typeof hex !== 'string' || hex.length === 0) continue
		try {
			validateGaiaLog(hex)
			return hex
		} catch { /* try next */ }
	}
	throw new Error('No GaiaLog OP_RETURN output found')
}

export function detectKnownNonGaia(scriptHex: string): { name: string; message: string } | null {
	try {
		let blob = ''
		try {
			const { pushes } = parsePushes(scriptHex)
			const texts = pushes.map(b => {
				try { return b.toString('utf8') } catch { return '' }
			}).filter(Boolean)
			blob = texts.join(' ')
		} catch {}
		try {
			const rawAscii = Buffer.from(scriptHex, 'hex').toString('latin1')
			const printable = rawAscii.split('').map(ch => {
				const c = ch.charCodeAt(0)
				return c >= 32 && c <= 126 ? ch : ' '
			}).join('')
			blob = `${blob} ${printable}`.toLowerCase()
		} catch {}
		if (blob.includes('rekord kloud') || blob.includes('"woctag":"rekord kloud"')) {
			return { name: 'rekord_kloud', message: "Oops! Looks like you are trying to view a 'Rekord Kloud' transaction.|Unfortunately, our plugin isn't compatible for this data." }
		}
		if (blob.includes('"p":"bsv-20"') || blob.includes('application/bsv-20') || blob.includes(' ord ')) {
			return { name: 'mnee', message: "Oops! It appears you are attempting to view a MNEE transaction.|Please select the MNEE Plugin to view the correct details." }
		}
		if (blob.includes('treechat_msg_id') || blob.includes('treechat_thread_id') || (blob.includes('app') && blob.includes('treechat'))) {
			return { name: 'treechat', message: "Sorry! It appears you are trying to view a Treechat transaction record.|Please switch to the Treechat BMAP Plugin." }
		}
		if (blob.includes('1lmv1pymp8s9yjun7m9hvtsdkdbau8kqnj@') || blob.includes('certihash')) {
			return { name: 'certihash', message: "Oops! It looks like you are trying to view a CertiHash transaction.|Unfortunately, that's not visible here." }
		}
	} catch {}
	return null
}

export async function GET(req: NextRequest) {
	try {
		const { searchParams } = new URL(req.url)
		const scriptHex = (searchParams.get('script_hex') || '').trim()
		const network = (searchParams.get('network') || 'main').trim()
		const txid = (searchParams.get('txid') || '').trim()
		const voutParam = searchParams.get('vout')
		const vout = typeof voutParam === 'string' ? Number(voutParam) : undefined

		// Show home page if no parameters provided
		if (!scriptHex && !txid) {
			const logoUrl = await (async () => {
				const candidates = [
					path.join(process.cwd(), 'public', 'gaialog-logo.png'),
					path.join(process.cwd(), 'public', 'gaialog-logo.svg'),
					path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.png'),
					path.join(process.cwd(), 'woc-plugin', 'GaiaLog Logo.png'),
					path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.svg'),
				]
				for (const p of candidates) {
					try {
						const buf = await fs.readFile(p)
						const mime = p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'
						return `data:${mime};base64,${buf.toString('base64')}`
					} catch {}
				}
				return null
			})()
			const html = renderHomeHtml({ logoUrl })
			return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
		}

		let key = ''
		let hex = scriptHex
		if (!hex) {
			if (!txid) throw new Error('Provide script_hex or txid')
			key = `GET:${network}:${txid}:${vout ?? -1}`
			const cached = getCache(key)
			if (cached) return new NextResponse(cached, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
			hex = await fetchTxAndFindScriptHex(network, txid, Number.isFinite(vout) ? vout : undefined)
		} else {
			key = `GET:hex:${hex.slice(0, 64)}`
			const cached = getCache(key)
			if (cached) return new NextResponse(cached, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
		}

		const decoded = validateGaiaLog(hex)
		const logoUrl = await (async () => {
			const candidates = [
				path.join(process.cwd(), 'public', 'gaialog-logo.png'),
				path.join(process.cwd(), 'public', 'gaialog-logo.svg'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'GaiaLog Logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.svg'),
			]
			for (const p of candidates) {
				try {
					const buf = await fs.readFile(p)
					const mime = p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'
					return `data:${mime};base64,${buf.toString('base64')}`
				} catch {}
			}
			return null
		})()
		const html = renderHtml({
			txid,
			network,
			json: decoded.json,
			spendable: decoded.spendable,
			hasHash: decoded.hasHash,
			isGzip: decoded.gzip,
			logoUrl,
		})
		setCache(key, html)
		return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
	} catch (e: any) {
		let message = e?.message || 'Decode error'
		try {
			const { searchParams } = new URL(req.url)
			const scriptHex = (searchParams.get('script_hex') || '').trim()
			const network = (searchParams.get('network') || 'main').trim()
			const txid = (searchParams.get('txid') || '').trim()
			const voutParam = searchParams.get('vout')
			const vout = typeof voutParam === 'string' ? Number(voutParam) : undefined
			const hex = scriptHex || (txid ? await fetchTxAndFindScriptHex(network, txid, Number.isFinite(vout) ? vout : undefined) : '')
			const detected = hex ? detectKnownNonGaia(hex) : null
			if (detected) message = detected.message
			else message = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
		} catch {
			message = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
		}
		// Load logo for consistent header in error view
		let logoUrl: string | null = null
		try {
			const candidates = [
				path.join(process.cwd(), 'public', 'gaialog-logo.png'),
				path.join(process.cwd(), 'public', 'gaialog-logo.svg'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'GaiaLog Logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.svg'),
			]
			for (const p of candidates) {
				try {
					const buf = await fs.readFile(p)
					const mime = p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'
					logoUrl = `data:${mime};base64,${buf.toString('base64')}`
					break
				} catch {}
			}
		} catch {}
		const html = renderErrorHtml({ message, logoUrl })
		return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 })
	}
}

export async function POST(req: NextRequest) {
	try {
		const body = await req.json().catch(() => ({}))
		const scriptHex = String(body?.script_hex || '').trim()
		const network = String(body?.network || 'main').trim()
		const txid = typeof body?.txid === 'string' ? body.txid : undefined
		const vout = Number.isFinite(body?.vout) ? Number(body.vout) : undefined
		const payloadJsonInput = body?.payload_json
		const buildFromPayload = typeof payloadJsonInput === 'string' && payloadJsonInput.trim().length > 0

		let hex = scriptHex
		if (!hex) {
			if (buildFromPayload) {
				const { buildOpFalseOpReturnWithTag } = await import('@/lib/opreturn')
				const buf = Buffer.from(String(payloadJsonInput), 'utf8')
				const extras: any[] = []
				const includeHash = body?.include_hash === true
				const useGzip = body?.gzip === true
				let dataBuf: any = buf
				if (useGzip) {
					const { gzipSync } = await import('zlib')
					dataBuf = gzipSync(buf)
				}
				if (includeHash) {
					const { createHash } = await import('crypto')
					const h = createHash('sha256').update(dataBuf).digest()
					extras.push(Buffer.from(h))
				}
				if (useGzip) extras.push('encoding=gzip')
				hex = buildOpFalseOpReturnWithTag({ tag: 'GaiaLog', version: 'v1', payload: dataBuf, extra: extras, useTrueReturn: false })
			} else {
				if (!txid) throw new Error('Provide script_hex, txid, or payload_json')
				hex = await fetchTxAndFindScriptHex(network, txid, vout)
			}
		}

		const key = `POST:${txid ?? 'hex'}:${hex.slice(0, 64)}`
		const cached = getCache(key)
		if (cached) return new NextResponse(cached, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })

		const decoded = validateGaiaLog(hex)
		const logoUrl = await (async () => {
			const candidates = [
				path.join(process.cwd(), 'public', 'gaialog-logo.png'),
				path.join(process.cwd(), 'public', 'gaialog-logo.svg'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'GaiaLog Logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.svg'),
			]
			for (const p of candidates) {
				try {
					const buf = await fs.readFile(p)
					const mime = p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'
					return `data:${mime};base64,${buf.toString('base64')}`
				} catch {}
			}
			return null
		})()
		const html = renderHtml({
			txid,
			network,
			json: decoded.json,
			spendable: decoded.spendable,
			hasHash: decoded.hasHash,
			isGzip: decoded.gzip,
			logoUrl,
		})
		setCache(key, html)
		return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
	} catch (e: any) {
		let message = e?.message || 'Decode error'
		try {
			const body = await req.json().catch(() => ({}))
			const scriptHex = String(body?.script_hex || '').trim()
			const network = String(body?.network || 'main').trim()
			const txid = typeof body?.txid === 'string' ? body.txid : undefined
			const vout = Number.isFinite(body?.vout) ? Number(body.vout) : undefined
			const hex = scriptHex || (txid ? await fetchTxAndFindScriptHex(network, txid, vout) : '')
			const detected = hex ? detectKnownNonGaia(hex) : null
			if (detected) message = detected.message
			else message = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
		} catch {
			message = "Unfortunately, this is not a GaiaLog transaction,|and is not compatible for decoding via this Plugin."
		}
		let logoUrl: string | null = null
		try {
			const candidates = [
				path.join(process.cwd(), 'public', 'gaialog-logo.png'),
				path.join(process.cwd(), 'public', 'gaialog-logo.svg'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'GaiaLog Logo.png'),
				path.join(process.cwd(), 'woc-plugin', 'gaialog-logo.svg'),
			]
			for (const p of candidates) {
				try {
					const buf = await fs.readFile(p)
					const mime = p.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/png'
					logoUrl = `data:${mime};base64,${buf.toString('base64')}`
					break
				} catch {}
			}
		} catch {}
		const html = renderErrorHtml({ message, logoUrl })
		return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 200 })
	}
}