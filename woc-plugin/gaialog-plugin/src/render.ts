/* HTML rendering for GaiaLog plugin */

import { getFamilyTitle, getKeyMetrics, getRenderableMetricEntries, resolveAttributionText } from './family-metadata.js'

/**
 * Root-level GaiaLog document fields. `lib/blockchain.ts` promotes
 * provider_id/dataset_id out of `payload` to the document root, so the renderer
 * must read attribution from the root document as well as the payload.
 */
export interface GaiaLogRootContext {
	provider_id?: string | null
	dataset_id?: string | null
	provider?: string | null
	source?: string | null
	data_type?: string | null
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
	try { return new Date(n).toISOString() } catch { return '' }
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

const BASE_STYLES = `
	*,*::before,*::after{box-sizing:border-box}
	html,body{margin:0;padding:0;min-height:100%}
	body{
		padding:12px;
		background:
			radial-gradient(900px 500px at 0% 0%, rgba(16,185,129,0.14), transparent 55%),
			radial-gradient(800px 500px at 100% 100%, rgba(34,211,238,0.10), transparent 55%),
			linear-gradient(145deg, #0c0620 0%, #050311 55%, #0f0728 100%);
		color:#f8fafc;
		font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;
		-webkit-font-smoothing:antialiased;
		-moz-osx-font-smoothing:grayscale;
	}
	.gl-root{
		--bg:#0c0620;
		--fg:#f8fafc;
		--muted:rgba(203,213,225,0.75);
		--card:rgba(255,255,255,0.045);
		--card-bd:rgba(255,255,255,0.09);
		--accent:#22d3ee;
		--accent-2:#2dd4bf;
		color:var(--fg);
		max-width:860px;
		margin:0 auto;
		border-radius:18px;
		padding:24px 22px 20px;
		background:
			radial-gradient(900px 420px at -10% -15%, rgba(16,185,129,0.16), transparent 50%),
			radial-gradient(700px 420px at 110% 10%, rgba(34,211,238,0.12), transparent 50%),
			linear-gradient(160deg, rgba(23,10,53,0.92) 0%, rgba(7,5,20,0.96) 55%, rgba(18,8,42,0.94) 100%);
		border:1px solid rgba(255,255,255,0.1);
		box-shadow:0 20px 50px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08);
		position:relative;
		overflow:hidden;
	}
	.gl-particles{position:absolute;inset:0;pointer-events:none;z-index:1}
	.gl-particle{position:absolute;border-radius:50%;background:radial-gradient(circle, rgba(255,255,255,0.85) 0%, rgba(165,243,252,0.45) 35%, transparent 70%);box-shadow:0 0 6px rgba(34,211,238,0.3);opacity:.28;animation:float 22s infinite ease-in-out}
	.gl-particle:nth-child(1){width:4px;height:4px;top:8%;left:12%;animation-duration:18s;animation-delay:0s}
	.gl-particle:nth-child(2){width:3px;height:3px;top:22%;left:78%;animation-duration:22s;animation-delay:2s}
	.gl-particle:nth-child(3){width:5px;height:5px;top:42%;left:8%;animation-duration:25s;animation-delay:4s}
	.gl-particle:nth-child(4){width:4px;height:4px;top:58%;left:72%;animation-duration:20s;animation-delay:1s}
	.gl-particle:nth-child(5){width:4px;height:4px;top:78%;left:28%;animation-duration:24s;animation-delay:3s}
	.gl-particle:nth-child(6){width:3px;height:3px;top:14%;left:48%;animation-duration:19s;animation-delay:5s}
	.gl-particle:nth-child(7){width:5px;height:5px;top:68%;left:58%;animation-duration:23s;animation-delay:2.5s}
	.gl-particle:nth-child(8){width:3px;height:3px;top:32%;left:88%;animation-duration:21s;animation-delay:1.5s}
	.gl-particle:nth-child(9){width:4px;height:4px;top:18%;left:35%;animation-duration:20s;animation-delay:3.5s}
	.gl-particle:nth-child(10){width:3px;height:3px;top:50%;left:92%;animation-duration:24s;animation-delay:1.2s}
	.gl-particle:nth-child(11){width:4px;height:4px;top:85%;left:15%;animation-duration:22s;animation-delay:4.5s}
	.gl-particle:nth-child(12){width:3px;height:3px;top:38%;left:42%;animation-duration:19s;animation-delay:2.8s}
	.gl-particle:nth-child(13){width:3px;height:3px;top:62%;left:20%;animation-duration:21s;animation-delay:0.5s}
	.gl-particle:nth-child(14){width:4px;height:4px;top:28%;left:65%;animation-duration:23s;animation-delay:3.2s}
	.gl-particle:nth-child(15){width:3px;height:3px;top:72%;left:82%;animation-duration:20s;animation-delay:1.8s}
	@keyframes float{0%,100%{transform:translate(0,0) scale(1);opacity:.28}25%{transform:translate(12px,-16px) scale(1.15);opacity:.38}50%{transform:translate(-8px,8px) scale(.9);opacity:.22}75%{transform:translate(16px,4px) scale(1.08);opacity:.32}}
	.gl-header{display:flex;flex-direction:column;align-items:center;gap:6px;margin-bottom:20px;text-align:center;position:relative;z-index:2}
	.gl-logo-wrap{position:relative;width:68px;height:68px;display:flex;align-items:center;justify-content:center;margin-bottom:2px}
	.gl-logo{width:64px;height:64px;border-radius:50%;object-fit:contain;position:relative;z-index:3}
	.gl-logo-wrap::before{content:'';position:absolute;width:76px;height:76px;border-radius:50%;border:2px solid transparent;border-top-color:#22d3ee;border-right-color:#2dd4bf;animation:glow-rotate 3.5s linear infinite;filter:drop-shadow(0 0 8px rgba(34,211,238,0.55)) drop-shadow(0 0 14px rgba(45,212,191,0.35));z-index:2}
	.gl-logo-wrap::after{content:'';position:absolute;width:76px;height:76px;border-radius:50%;border:2px solid transparent;border-bottom-color:#22d3ee;border-left-color:#2dd4bf;animation:glow-rotate 3.5s linear infinite reverse;filter:drop-shadow(0 0 6px rgba(34,211,238,0.45)) drop-shadow(0 0 10px rgba(45,212,191,0.25));z-index:2;opacity:.65}
	@keyframes glow-rotate{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
	.gl-title-big{font-size:26px;font-weight:800;letter-spacing:-0.02em;line-height:1.15;color:#ffffff;background:linear-gradient(135deg,#ffffff 35%,#a5f3fc 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
	.gl-tagline{font-size:13px;font-style:italic;color:rgba(226,232,240,0.72);margin-top:3px;text-align:center;letter-spacing:0.01em}
	.gl-card{
		background:var(--card);
		border:1px solid var(--card-bd);
		border-radius:14px;
		padding:16px;
		margin:12px 0;
		backdrop-filter:blur(10px);
		-webkit-backdrop-filter:blur(10px);
		box-shadow:inset 0 1px 0 rgba(255,255,255,0.05);
		position:relative;
		z-index:2;
	}
	.gl-card-title{
		display:flex;
		align-items:center;
		gap:8px;
		font-size:15px;
		font-weight:700;
		letter-spacing:0.01em;
		margin-bottom:12px;
		color:#f8fafc;
	}
	.gl-card-title::before{
		content:'';
		display:inline-block;
		width:3px;
		height:15px;
		border-radius:999px;
		background:linear-gradient(180deg,var(--accent),var(--accent-2));
		box-shadow:0 0 8px rgba(34,211,238,0.5);
		flex-shrink:0;
	}
	.gl-chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
	.gl-chip{
		display:inline-flex;
		flex-wrap:wrap;
		gap:5px;
		align-items:center;
		justify-content:center;
		padding:7px 12px;
		border-radius:10px;
		background:rgba(255,255,255,0.055);
		border:1px solid rgba(255,255,255,0.1);
		flex:1 1 160px;
		min-width:0;
		font-size:12.5px;
		line-height:1.35;
		text-align:center;
		transition:background 0.2s ease,border-color 0.2s ease;
	}
	.gl-chip:hover{background:rgba(255,255,255,0.09);border-color:rgba(34,211,238,0.28)}
	.gl-chip-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:rgba(148,163,184,0.88);white-space:nowrap}
	.gl-chip-val{font-weight:600;color:#f8fafc;word-break:break-word;font-variant-numeric:tabular-nums}
	.gl-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
	@media (min-width:640px){.gl-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}}
	.gl-stat{
		background:rgba(255,255,255,0.04);
		border:1px solid rgba(255,255,255,0.085);
		border-radius:12px;
		padding:12px 14px;
		box-shadow:inset 0 1px 0 rgba(255,255,255,0.04);
		transition:background 0.2s ease,border-color 0.2s ease,transform 0.2s ease,box-shadow 0.2s ease;
	}
	.gl-stat:hover{
		background:rgba(255,255,255,0.075);
		border-color:rgba(34,211,238,0.28);
		transform:translateY(-1px);
		box-shadow:0 6px 18px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.07);
	}
	.gl-stat-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:rgba(148,163,184,0.9);margin-bottom:6px;line-height:1.2}
	.gl-stat-value{font-size:17px;font-weight:700;color:#f8fafc;letter-spacing:-0.01em;word-break:break-word;font-variant-numeric:tabular-nums;line-height:1.25}
	.gl-attribution{font-size:12.5px;line-height:1.6;color:rgba(226,232,240,0.82)}
	.gl-pre{white-space:pre-wrap;word-wrap:break-word;margin:12px 0 0;color:#cbd5e1;font-size:12px;line-height:1.55;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;background:rgba(0,0,0,0.32);border-radius:10px;padding:12px;border:1px solid rgba(255,255,255,0.08);max-height:360px;overflow:auto}
	.gl-details summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;margin-bottom:0;transition:opacity 0.2s ease}
	.gl-details summary:hover{opacity:.9}
	.gl-details summary::-webkit-details-marker{display:none}
	.gl-details summary::after{content:"Expand \\25BE";font-size:11.5px;font-weight:600;background:rgba(45,212,191,0.12);color:#99f6e4;padding:4px 10px;border-radius:999px;border:1px solid rgba(45,212,191,0.25);transition:background 0.2s ease,border-color 0.2s ease;margin-left:auto}
	.gl-details summary:hover::after{background:rgba(45,212,191,0.2);border-color:rgba(45,212,191,0.4)}
	.gl-details[open] summary::after{content:"Collapse \\25B4"}
	.gl-footer{display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid rgba(255,255,255,0.08);position:relative;z-index:2}
	.gl-footer-meta{font-size:11.5px;color:rgba(148,163,184,0.8);letter-spacing:0.02em}
	.gl-btn{display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#22d3ee,#2dd4bf);color:#061224;text-decoration:none;padding:8px 18px;border-radius:999px;font-weight:700;font-size:13px;border:0;box-shadow:0 4px 16px rgba(34,211,238,0.25);transition:transform 0.2s ease,box-shadow 0.2s ease,filter 0.2s ease}
	.gl-btn:hover{transform:translateY(-1px);box-shadow:0 6px 24px rgba(34,211,238,0.38);filter:brightness(1.05)}
	.gl-home-content{text-align:center;line-height:1.6}
	.gl-home-content p{margin:10px 0;color:rgba(226,232,240,0.88)}
	.gl-home-content code{background:rgba(0,0,0,0.32);padding:2px 6px;border-radius:5px;font-size:12.5px;font-family:ui-monospace,monospace}
	.gl-showcase-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:16px 0}
	@media (max-width:640px){.gl-showcase-grid{grid-template-columns:1fr}}
	.gl-showcase-card{background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:12px;padding:14px;text-align:center;transition:background 0.2s ease,border-color 0.2s ease,transform 0.2s ease}
	.gl-showcase-card:hover{background:rgba(255,255,255,0.08);border-color:rgba(34,211,238,0.28);transform:translateY(-2px)}
	.gl-showcase-card-title{font-weight:700;font-size:14.5px;margin-bottom:6px;color:#f8fafc}
	.gl-showcase-card-desc{font-size:12px;color:rgba(203,213,225,0.78);line-height:1.45}
	.gl-address-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0}
	@media (max-width:640px){.gl-address-grid{grid-template-columns:1fr}}
	.gl-address-card{background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:12px;padding:12px 14px;text-align:center;transition:background 0.2s ease,border-color 0.2s ease,transform 0.2s ease;text-decoration:none;color:inherit;display:block}
	.gl-address-card:hover{background:rgba(255,255,255,0.085);border-color:rgba(34,211,238,0.3);transform:translateY(-2px)}
	.gl-address-label{font-size:10.5px;color:rgba(148,163,184,0.85);margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap}
	.gl-address-value{font-size:11.5px;font-family:ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#e2e8f0;font-weight:500}
	@media (max-width:520px){
		body{padding:8px}
		.gl-root{padding:16px 12px 14px;border-radius:14px}
		.gl-header{margin-bottom:14px}
		.gl-logo-wrap{width:58px;height:58px}
		.gl-logo{width:54px;height:54px}
		.gl-logo-wrap::before,.gl-logo-wrap::after{width:64px;height:64px}
		.gl-title-big{font-size:22px}
		.gl-tagline{font-size:12px}
		.gl-card{padding:12px;border-radius:12px;margin:10px 0}
		.gl-card-title{font-size:14px;margin-bottom:10px}
		.gl-chips{gap:6px;margin-bottom:12px}
		.gl-chip{flex:1 1 130px;padding:6px 10px;justify-content:space-between;text-align:left;font-size:12px}
		.gl-grid{gap:8px}
		.gl-stat{padding:10px 11px;border-radius:10px}
		.gl-stat-label{font-size:10.5px;margin-bottom:4px}
		.gl-stat-value{font-size:15px}
	}
	@media (prefers-reduced-motion:reduce){
		.gl-particle,.gl-logo-wrap::before,.gl-logo-wrap::after{animation:none}
		.gl-stat,.gl-chip,.gl-btn,.gl-showcase-card,.gl-address-card{transition:none}
	}
`

export function renderTypeSections(dataType: string, payload: any, root?: GaiaLogRootContext | null): string {
	const sections: string[] = []
	const p = payload || {}

	const loc = p?.location_ascii ?? p?.location
	const ts = p?.timestamp
	const dateISO = typeof ts === 'string' && ts.includes('T') ? ts : (fmtIso(ts) || '')
	const datePart = dateISO ? String(dateISO).slice(0, 10) : ''
	const timePart = dateISO ? (dateISO.includes('T') ? String(dateISO).slice(11, 19) : '') : ''

	// Attribution lives at the document root because blockchain.ts strips
	// provider_id/dataset_id from the payload. Fall back to payload fields for
	// legacy documents that still carry them inline.
	const providerId = root?.provider_id ?? p.provider_id ?? null
	const datasetId = root?.dataset_id ?? p.dataset_id ?? null
	const sourceLabel = root?.provider ?? p.source ?? null

	const primaryStats = getKeyMetrics(dataType, p, 12)
	const secondaryStats = getRenderableMetricEntries(p, 24)
		.filter(entry => !primaryStats.some(primary => primary.label === entry.label && primary.value === entry.value))
	const attributionText = resolveAttributionText(providerId, sourceLabel)

	sections.push(`
		<div class="gl-card">
			<div class="gl-card-title">${escapeHtml(getFamilyTitle(dataType))}</div>
			<div class="gl-chips">
				${chip('Location', loc)}
				${chip('Date', datePart)}
				${chip('Time', timePart)}
				${chip('Provider', providerId ?? sourceLabel ?? '')}
				${chip('Dataset', datasetId ?? '')}
			</div>
			<div class="gl-grid">
				${(primaryStats.length > 0 ? primaryStats : secondaryStats).map(entry => stat(entry.label, entry.value)).join('')}
			</div>
		</div>
	`)

	if (secondaryStats.length > primaryStats.length) {
		sections.push(`
			<div class="gl-card">
				<div class="gl-card-title">Additional Metrics</div>
				<div class="gl-grid">
					${secondaryStats.slice(0, 24).map(entry => stat(entry.label, entry.value)).join('')}
				</div>
			</div>
		`)
	}

	if (attributionText) {
		sections.push(`
			<div class="gl-card">
				<div class="gl-card-title">Attribution</div>
				<div class="gl-attribution">${escapeHtml(attributionText)}</div>
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
		<style>${BASE_STYLES}</style>
	</head>
	<body>
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
			${renderTypeSections(String(json?.data_type ?? '').trim(), json?.payload, json)}
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
		<style>${BASE_STYLES}</style>
	</head>
	<body>
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
					<p style="margin-bottom:20px;font-size:12.5px;font-style:italic">
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
					<p style="margin-bottom:12px;font-weight:600">Browse Transactions by Address:</p>
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
				<div class="gl-home-content" style="margin-top:20px">
					<p style="opacity:.8;font-size:13px">
						For more information, visit <a href="https://gaialog.world" target="_blank" rel="noopener" style="color:#22d3ee;text-decoration:none;font-weight:600">gaialog.world</a>
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
		<style>${BASE_STYLES}</style>
	</head>
	<body>
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
					<div class="gl-card-title" style="justify-content:center">GaiaLog Decoder</div>
					<div style="font-size:14.5px;color:rgba(226,232,240,0.92);line-height:1.6">${message.includes('|') ? message.split('|').map((line: string) => escapeHtml(line.trim())).join('<br>') : escapeHtml(message)}</div>
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



